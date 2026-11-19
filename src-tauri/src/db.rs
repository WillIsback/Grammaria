//! Accès SQLite du journal des fautes.
//!
//! La logique du journal reste en TypeScript (source unique, partagée avec le
//! serveur web) : Rust n'expose que trois commandes génériques sur le fichier
//! `grammaria.db` du dossier de données, celui du serveur Bun, repris tel quel.
//!
//! - `db_read` : UNE requête en lecture seule, lignes en objets JSON ;
//! - `db_read_many` : plusieurs lectures dans un même instantané ;
//! - `db_batch` : un lot d'écritures dans UNE transaction, tout ou rien.
//!
//! # Garde-fous
//!
//! La page n'est pas censée envoyer autre chose que les requêtes du journal,
//! mais Rust ne lui fait pas confiance pour autant :
//!
//! - une seule instruction par entrée (`SELECT 1; DELETE …` est refusé) ;
//! - `db_read` refuse toute instruction qui écrit (`sqlite3_stmt_readonly`) ;
//! - un autorisateur SQLite interdit, pour le SQL de la page, `ATTACH`,
//!   `DETACH`, `load_extension()`, le contrôle des transactions (`BEGIN`,
//!   `COMMIT`, `SAVEPOINT`… : c'est Rust qui garantit l'atomicité), les tables
//!   virtuelles et tout pragma hors d'une courte liste (seul `user_version`
//!   peut être modifié, pour les migrations du schéma) ;
//! - `VACUUM` (dont `VACUUM INTO 'fichier'`) est refusé ;
//! - le mode défensif de SQLite protège le schéma interne (`sqlite_master`,
//!   `writable_schema`…), `trusted_schema` est coupé et aucune base ne peut
//!   être attachée (`SQLITE_LIMIT_ATTACHED` = 0).
//!
//! # Types
//!
//! Paramètres et colonnes : `null`, nombres, chaînes (et booléens en
//! paramètre, enregistrés 0/1 comme le fait `bun:sqlite`). Les entiers SQLite
//! sont sur 64 bits et sont transmis en JSON chiffre pour chiffre ; côté
//! JavaScript, `JSON.parse` n'est exact que jusqu'à 2^53 − 1, comme
//! `bun:sqlite` sans `safeIntegers`. Les valeurs du journal (horodatages en
//! millisecondes, identifiants, compteurs) en sont très loin : un horodatage
//! en millisecondes n'atteint 2^53 qu'en l'an 287 396. Les BLOB, absents du
//! schéma, sont refusés avec un message clair.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::config::DbConfig;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::limits::Limit;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, ErrorCode, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use tauri::State;

/// Nom du fichier du journal dans le dossier de données de l'application.
pub const JOURNAL_FILE: &str = "grammaria.db";

/// Attente maximale d'un verrou tenu par une autre connexion (le serveur Bun
/// pendant la transition, une autre écriture…).
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Une ligne de résultat : nom de colonne → valeur.
pub type Row = Map<String, Value>;

/// Une requête de lecture (`db_read_many`).
#[derive(Debug, Deserialize)]
pub struct Query {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

/// Une instruction d'un lot (`db_batch`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    pub sql: String,
    /// Valeurs des `?`. `{"$rowid": n}` vaut le `lastInsertRowid` de
    /// l'instruction n (antérieure) du même lot.
    #[serde(default)]
    pub params: Vec<Value>,
    /// Le lot entier est annulé si l'instruction ne modifie pas exactement ce
    /// nombre de lignes (garde optimiste : « réponse déjà enregistrée »…).
    #[serde(default)]
    pub expect_changes: Option<u64>,
}

/// Résultat d'une instruction d'un lot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    /// Lignes modifiées par l'instruction elle-même (0 pour une instruction
    /// qui n'insère, ne modifie ni ne supprime rien : `CREATE TABLE`, pragma…).
    pub changes: u64,
    /// `sqlite3_last_insert_rowid` après l'instruction (connexion entière,
    /// comme `bun:sqlite` : inchangé par une instruction qui n'insère rien).
    pub last_insert_rowid: i64,
}

/// Connexion ouverte et drapeau « SQL de la page en cours ».
struct Guarded {
    conn: Connection,
    /// Vrai pendant la préparation et l'exécution d'une instruction venue de
    /// la page : l'autorisateur applique alors les règles strictes. Le SQL de
    /// Rust (`BEGIN IMMEDIATE`, `COMMIT`, pragmas d'ouverture) passe à côté.
    page: Arc<AtomicBool>,
}

/// Base du journal, ouverte au premier usage : tant que l'interface passe par
/// le serveur Bun, Rust ne touche pas au fichier.
pub struct Db(Arc<DbInner>);

struct DbInner {
    path: PathBuf,
    conn: Mutex<Option<Guarded>>,
}

impl Db {
    pub fn new(path: PathBuf) -> Self {
        Db(Arc::new(DbInner {
            path,
            conn: Mutex::new(None),
        }))
    }

    /// Exécute `work` avec la connexion, ouverte au besoin. Un verrou
    /// empoisonné (panique pendant un appel précédent) ne bloque pas le
    /// journal : la connexion reste cohérente, SQLite ayant annulé la
    /// transaction en cours à la destruction de `Transaction`.
    fn with<T>(&self, work: impl FnOnce(&mut Guarded) -> Result<T, String>) -> Result<T, String> {
        let mut slot = self
            .0
            .conn
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if slot.is_none() {
            *slot = Some(
                open(&self.0.path)
                    .map_err(|error| format!("Impossible d'ouvrir le journal ({error})."))?,
            );
        }
        work(slot.as_mut().expect("connexion ouverte ci-dessus"))
    }

    /// Même chose sur un fil dédié : SQLite est bloquant, il ne doit occuper
    /// ni le fil principal (interface) ni ceux du moteur asynchrone.
    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Guarded) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let db = Db(self.0.clone());
        tauri::async_runtime::spawn_blocking(move || db.with(work))
            .await
            .map_err(|error| format!("Accès au journal interrompu ({error})."))?
    }
}

/// Ouvre la base avec les mêmes réglages que le serveur (`journal.ts` : WAL,
/// clés étrangères) et les garde-fous décrits en tête du module.
fn open(path: &Path) -> rusqlite::Result<Guarded> {
    if let Some(dir) = path.parent() {
        // Erreur éventuelle reportée par l'ouverture elle-même.
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "trusted_schema", "OFF")?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)?;
    conn.set_prepared_statement_cache_capacity(64);
    let page = Arc::new(AtomicBool::new(false));
    let flag = page.clone();
    conn.authorizer(Some(move |context: AuthContext<'_>| {
        authorize(flag.load(Ordering::Relaxed), context)
    }));
    Ok(Guarded { conn, page })
}

/// Pragmas que la page peut lire (sans valeur) ou appeler avec un nom de
/// table ou d'index en argument : aucun ne modifie quoi que ce soit.
const PRAGMAS_LECTURE: &[&str] = &[
    "application_id",
    "data_version",
    "encoding",
    "foreign_key_check",
    "foreign_key_list",
    "foreign_keys",
    "freelist_count",
    "index_info",
    "index_list",
    "index_xinfo",
    "integrity_check",
    "journal_mode",
    "page_count",
    "page_size",
    "quick_check",
    "schema_version",
    "table_info",
    "table_xinfo",
    "user_version",
];

/// Pragmas dont l'argument est un nom (table, index), pas un réglage.
const PRAGMAS_A_ARGUMENT: &[&str] = &[
    "foreign_key_check",
    "foreign_key_list",
    "index_info",
    "index_list",
    "index_xinfo",
    "integrity_check",
    "quick_check",
    "table_info",
    "table_xinfo",
];

fn pragma_allowed(name: &str, value: Option<&str>) -> bool {
    let name = name.to_ascii_lowercase();
    match value {
        None => PRAGMAS_LECTURE.contains(&name.as_str()),
        // Seule écriture permise : la version du schéma, pour les migrations.
        Some(_) => name == "user_version" || PRAGMAS_A_ARGUMENT.contains(&name.as_str()),
    }
}

/// Autorisateur SQLite, appelé à la préparation de chaque instruction.
fn authorize(page: bool, context: AuthContext<'_>) -> Authorization {
    match context.action {
        // Jamais, pour personne : ni autre fichier, ni extension native.
        AuthAction::Attach { .. } | AuthAction::Detach { .. } => Authorization::Deny,
        AuthAction::Function { function_name }
            if function_name.eq_ignore_ascii_case("load_extension") =>
        {
            Authorization::Deny
        }
        _ if !page => Authorization::Allow,
        // Rust ouvre et ferme lui-même les transactions des commandes.
        AuthAction::Transaction { .. } | AuthAction::Savepoint { .. } => Authorization::Deny,
        AuthAction::CreateVtable { .. } | AuthAction::DropVtable { .. } => Authorization::Deny,
        AuthAction::Pragma {
            pragma_name,
            pragma_value,
        } if !pragma_allowed(pragma_name, pragma_value) => Authorization::Deny,
        AuthAction::Unknown { .. } => Authorization::Deny,
        _ => Authorization::Allow,
    }
}

/// Premier mot-clé du SQL, commentaires et blancs de tête ignorés.
fn first_keyword(sql: &str) -> Option<String> {
    let mut rest = sql;
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, tail)| tail);
        } else {
            break;
        }
    }
    let word: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    (!word.is_empty()).then(|| word.to_ascii_uppercase())
}

/// Contrôles faits avant même la préparation.
fn check_sql(sql: &str) -> Result<(), String> {
    match first_keyword(sql).as_deref() {
        None => Err("Instruction SQL vide.".into()),
        // VACUUM (et VACUUM INTO 'fichier') n'a rien à faire depuis la page.
        Some("VACUUM") => Err("VACUUM n'est pas autorisé.".into()),
        Some(_) => Ok(()),
    }
}

/// Message lisible pour une erreur SQLite.
fn sql_error(error: rusqlite::Error) -> String {
    if matches!(error, rusqlite::Error::MultipleStatement) {
        return "Une seule instruction SQL par entrée.".into();
    }
    let text = error.to_string();
    // Refus de l'autorisateur : SQLITE_AUTH, ou SQLITE_ERROR « not
    // authorized… » quand le refus tombe pendant la préparation.
    if error.sqlite_error_code() == Some(ErrorCode::AuthorizationForStatementDenied)
        || text.starts_with("not authorized")
    {
        return format!("Instruction non autorisée ({text}).");
    }
    text
}

/// Le drapeau « SQL de la page » levé le temps d'une instruction.
struct PageScope<'a>(&'a AtomicBool);

impl<'a> PageScope<'a> {
    fn enter(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::Relaxed);
        PageScope(flag)
    }
}

impl Drop for PageScope<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// JSON → SQLite. `rowids` vaut `None` hors d'un lot (`$rowid` refusé).
fn bind(value: &Value, rowids: Option<&[i64]>) -> Result<SqlValue, String> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        Value::Number(number) => match (number.as_i64(), number.as_u64()) {
            (Some(integer), _) => SqlValue::Integer(integer),
            (None, Some(_)) => {
                return Err(format!(
                    "Paramètre {number} : entier hors des 64 bits signés de SQLite."
                ))
            }
            (None, None) => SqlValue::Real(
                number
                    .as_f64()
                    .ok_or_else(|| format!("Paramètre {number} : nombre invalide."))?,
            ),
        },
        Value::String(text) => SqlValue::Text(text.clone()),
        Value::Object(object) => {
            let index = match (object.len(), object.get("$rowid").and_then(Value::as_u64)) {
                (1, Some(index)) => index,
                _ => return Err("Paramètre objet inconnu (seul {\"$rowid\": n} existe).".into()),
            };
            let rowids = rowids.ok_or("{\"$rowid\": n} n'est admis que dans un lot (db_batch).")?;
            let rowid = usize::try_from(index)
                .ok()
                .and_then(|index| rowids.get(index))
                .ok_or_else(|| {
                    format!("{{\"$rowid\": {index}}} : l'instruction {index} ne précède pas celle-ci dans le lot.")
                })?;
            SqlValue::Integer(*rowid)
        }
        Value::Array(_) => return Err("Paramètre tableau refusé.".into()),
    })
}

fn bind_all(params: &[Value], rowids: Option<&[i64]>) -> Result<Vec<SqlValue>, String> {
    params.iter().map(|value| bind(value, rowids)).collect()
}

/// SQLite → JSON.
fn to_json(column: &str, value: ValueRef<'_>) -> Result<Value, String> {
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(integer) => Value::Number(integer.into()),
        ValueRef::Real(real) => Value::Number(
            Number::from_f64(real)
                .ok_or_else(|| format!("Colonne « {column} » : réel non fini ({real})."))?,
        ),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(_) => {
            return Err(format!(
                "Colonne « {column} » : les BLOB ne sont pas pris en charge."
            ))
        }
    })
}

/// Une lecture : instruction unique, en lecture seule, règles strictes.
fn read(
    conn: &Connection,
    page: &AtomicBool,
    sql: &str,
    params: &[Value],
) -> Result<Vec<Row>, String> {
    check_sql(sql)?;
    let bound = bind_all(params, None)?;
    let _page = PageScope::enter(page);
    let mut statement = conn.prepare_cached(sql).map_err(sql_error)?;
    if !statement.readonly() {
        return Err("db_read n'accepte que des lectures : cette instruction écrit.".into());
    }
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut rows = statement
        .query(params_from_iter(bound))
        .map_err(sql_error)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(sql_error)? {
        let mut object = Map::with_capacity(names.len());
        for (index, name) in names.iter().enumerate() {
            let value = row.get_ref(index).map_err(sql_error)?;
            object.insert(name.clone(), to_json(name, value)?);
        }
        out.push(object);
    }
    Ok(out)
}

fn read_many(guarded: &mut Guarded, queries: &[Query]) -> Result<Vec<Vec<Row>>, String> {
    let page = guarded.page.clone();
    // Une transaction de lecture : toutes les requêtes voient le même état,
    // même si une autre connexion écrit entre deux.
    let tx = guarded.conn.transaction().map_err(sql_error)?;
    let results = queries
        .iter()
        .map(|query| read(&tx, &page, &query.sql, &query.params))
        .collect::<Result<Vec<_>, _>>()?;
    tx.commit().map_err(sql_error)?;
    Ok(results)
}

fn batch(guarded: &mut Guarded, statements: &[Statement]) -> Result<Vec<StatementResult>, String> {
    let page = guarded.page.clone();
    // IMMEDIATE : le verrou d'écriture est pris dès le début, pas à la
    // première écriture (pas d'échec « base verrouillée » en plein lot).
    let tx = guarded
        .conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    let mut rowids = Vec::with_capacity(statements.len());
    let mut results = Vec::with_capacity(statements.len());
    for (index, statement) in statements.iter().enumerate() {
        let fail = |message: String| format!("Instruction {index} : {message} Lot annulé.");
        check_sql(&statement.sql).map_err(fail)?;
        let bound = bind_all(&statement.params, Some(&rowids)).map_err(fail)?;
        let before = tx.total_changes();
        {
            let _page = PageScope::enter(&page);
            let mut prepared = tx
                .prepare_cached(&statement.sql)
                .map_err(|error| fail(sql_error(error)))?;
            // Jusqu'au bout, lignes renvoyées (RETURNING) ignorées.
            let mut rows = prepared
                .query(params_from_iter(bound))
                .map_err(|error| fail(sql_error(error)))?;
            while rows
                .next()
                .map_err(|error| fail(sql_error(error)))?
                .is_some()
            {}
        }
        // `sqlite3_changes` garde la valeur de la dernière écriture : après un
        // CREATE TABLE, il rendrait celle de l'instruction précédente.
        let changes = if tx.total_changes() == before {
            0
        } else {
            tx.changes()
        };
        if let Some(expected) = statement.expect_changes {
            if expected != changes {
                // `tx` est abandonnée en sortant : ROLLBACK.
                return Err(format!(
                    "Conflit : l'instruction {index} a modifié {changes} ligne(s), {expected} attendue(s). Lot annulé."
                ));
            }
        }
        let rowid = tx.last_insert_rowid();
        rowids.push(rowid);
        results.push(StatementResult {
            changes,
            last_insert_rowid: rowid,
        });
    }
    tx.commit().map_err(sql_error)?;
    Ok(results)
}

/// Une requête en lecture seule ; refusée si elle écrit.
#[tauri::command]
pub async fn db_read(
    db: State<'_, Db>,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<Vec<Row>, String> {
    db.run(move |guarded| {
        read(
            &guarded.conn,
            &guarded.page,
            &sql,
            &params.unwrap_or_default(),
        )
    })
    .await
}

/// Plusieurs lectures dans un même instantané, en un aller-retour.
#[tauri::command]
pub async fn db_read_many(db: State<'_, Db>, queries: Vec<Query>) -> Result<Vec<Vec<Row>>, String> {
    db.run(move |guarded| read_many(guarded, &queries)).await
}

/// Un lot d'écritures dans une transaction : tout ou rien.
#[tauri::command]
pub async fn db_batch(
    db: State<'_, Db>,
    statements: Vec<Statement>,
) -> Result<Vec<StatementResult>, String> {
    db.run(move |guarded| batch(guarded, &statements)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Schéma créé par le serveur actuel : copie de `journal.ts`,
    /// `journal.rules.ts` et `journal.badges.ts` (version 2).
    const SCHEMA_SERVEUR: &str = "
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS texts (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        created_at INTEGER NOT NULL,
        word_count INTEGER NOT NULL,
        fault_count INTEGER NOT NULL,
        unclassified_count INTEGER NOT NULL,
        score REAL
      );
      CREATE TABLE IF NOT EXISTS faults (
        id INTEGER PRIMARY KEY,
        text_id INTEGER NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL DEFAULT 'local',
        created_at INTEGER NOT NULL,
        rule_key TEXT NOT NULL,
        source TEXT NOT NULL,
        category_id TEXT NOT NULL,
        category_name TEXT NOT NULL,
        issue_type TEXT NOT NULL,
        message TEXT NOT NULL,
        word TEXT NOT NULL,
        replacement TEXT NOT NULL,
        sentence TEXT NOT NULL,
        counted INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_texts_created ON texts(created_at);
      CREATE INDEX IF NOT EXISTS idx_faults_rule ON faults(rule_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_faults_word ON faults(word, created_at);
      CREATE TABLE IF NOT EXISTS rule_states (
        rule_key TEXT NOT NULL PRIMARY KEY,
        state TEXT NOT NULL,
        state_since INTEGER NOT NULL,
        occurrences INTEGER NOT NULL,
        first_fault_at INTEGER NOT NULL,
        last_fault_at INTEGER NOT NULL,
        tips_shown INTEGER NOT NULL DEFAULT 0,
        choices_shown INTEGER NOT NULL DEFAULT 0,
        choices_correct INTEGER NOT NULL DEFAULT 0,
        choices_wrong INTEGER NOT NULL DEFAULT 0,
        last_solicited_at INTEGER,
        solicitations_that_day INTEGER NOT NULL DEFAULT 0,
        acquired_at INTEGER,
        relapses INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rule_events (
        id INTEGER PRIMARY KEY,
        rule_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rule_events_rule ON rule_events(rule_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_rule_events_created ON rule_events(created_at);
      CREATE TABLE IF NOT EXISTS badges (
        badge_id TEXT NOT NULL PRIMARY KEY,
        obtained_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    ";

    /// Horodatage en millisecondes réaliste (novembre 2026).
    const MAINTENANT: i64 = 1_795_000_000_000;
    /// Marge : mille fois l'horodatage actuel tient encore sous 2^53.
    const _: () = assert!(MAINTENANT * 1000 < 1 << 53);

    struct Banc {
        _dir: tempfile::TempDir,
        path: PathBuf,
        db: Db,
    }

    /// Base créée comme le ferait le serveur Bun, avec un texte et une faute.
    fn banc() -> Banc {
        let dir = tempfile::tempdir().expect("dossier temporaire");
        let path = dir.path().join(JOURNAL_FILE);
        {
            let serveur = Connection::open(&path).expect("base du serveur");
            serveur.execute_batch(SCHEMA_SERVEUR).expect("schéma");
            serveur
                .execute(
                    "INSERT INTO texts (created_at, word_count, fault_count, unclassified_count, score)
                     VALUES (?, 120, 1, 0, 17.5)",
                    [MAINTENANT],
                )
                .expect("texte");
            serveur
                .execute(
                    "INSERT INTO faults (text_id, created_at, rule_key, source, category_id,
                       category_name, issue_type, message, word, replacement, sentence, counted)
                     VALUES (1, ?, 'ACCORD', 'lt', 'GRAMMAR', 'Grammaire', 'grammar',
                       'Accord', 'mangé', 'mangés', 'Ils ont mangés.', 1)",
                    [MAINTENANT],
                )
                .expect("faute");
        }
        let db = Db::new(path.clone());
        Banc {
            _dir: dir,
            path,
            db,
        }
    }

    impl Banc {
        fn read(&self, sql: &str, params: Vec<Value>) -> Result<Vec<Row>, String> {
            self.db.with(|g| read(&g.conn, &g.page, sql, &params))
        }

        fn batch(&self, statements: Value) -> Result<Vec<StatementResult>, String> {
            let statements: Vec<Statement> =
                serde_json::from_value(statements).expect("lot bien formé");
            self.db.with(|g| batch(g, &statements))
        }

        /// Lu par Rust directement : pour SQLite, `PRAGMA journal_mode` n'est
        /// pas une instruction en lecture seule, `db_read` le refuse donc.
        fn journal_mode(&self) -> String {
            self.db
                .with(|g| {
                    g.conn
                        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
                        .map_err(sql_error)
                })
                .unwrap()
        }

        fn count(&self, table: &str) -> i64 {
            self.read(&format!("SELECT COUNT(*) AS n FROM {table}"), vec![])
                .expect("comptage")[0]["n"]
                .as_i64()
                .expect("entier")
        }
    }

    #[test]
    fn une_base_creee_par_le_serveur_est_relue_telle_quelle() {
        let banc = banc();
        let version = banc.read("PRAGMA user_version", vec![]).unwrap();
        assert_eq!(
            version,
            vec![json!({"user_version": 2}).as_object().unwrap().clone()]
        );

        let textes = banc
            .read(
                "SELECT id, created_at, word_count, score, user_id FROM texts WHERE created_at >= ?",
                vec![json!(MAINTENANT - 1)],
            )
            .unwrap();
        assert_eq!(
            Value::Array(textes.into_iter().map(Value::Object).collect()),
            json!([{"id": 1, "created_at": MAINTENANT, "word_count": 120, "score": 17.5, "user_id": "local"}])
        );
        let faute = banc
            .read("SELECT word, sentence, counted FROM faults", vec![])
            .unwrap();
        assert_eq!(faute[0]["word"], "mangé");
        assert_eq!(faute[0]["sentence"], "Ils ont mangés.");
        assert_eq!(faute[0]["counted"], 1);

        // Mêmes réglages que le serveur : WAL et clés étrangères.
        assert_eq!(banc.journal_mode(), "wal");
        let fk = banc.read("PRAGMA foreign_keys", vec![]).unwrap();
        assert_eq!(fk[0]["foreign_keys"], 1);
        // Clé étrangère appliquée : une faute sans texte est refusée.
        let orpheline = banc.batch(json!([{
            "sql": "INSERT INTO faults (text_id, created_at, rule_key, source, category_id, category_name,
                      issue_type, message, word, replacement, sentence, counted)
                    VALUES (999, 0, 'R', 's', 'c', 'n', 'i', 'm', 'w', 'r', 's', 0)"
        }]));
        assert!(orpheline.unwrap_err().contains("FOREIGN KEY"));
    }

    #[test]
    fn la_base_est_ouverte_au_premier_usage_seulement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sous-dossier").join(JOURNAL_FILE);
        let db = Db::new(path.clone());
        assert!(!path.exists());
        db.with(|g| read(&g.conn, &g.page, "SELECT 1 AS un", &[]))
            .unwrap();
        assert!(path.exists());
    }

    #[test]
    fn db_read_refuse_toute_ecriture() {
        let banc = banc();
        for sql in [
            "DELETE FROM texts",
            "UPDATE texts SET score = 0",
            "INSERT INTO badges VALUES ('x', 1)",
            "INSERT INTO badges VALUES ('x', 1) RETURNING *",
            "CREATE TABLE autre (x)",
            "DROP TABLE badges",
            "PRAGMA user_version = 99",
            "REPLACE INTO badges VALUES ('x', 1)",
            "WITH t AS (SELECT 1) DELETE FROM texts",
        ] {
            let error = banc.read(sql, vec![]).unwrap_err();
            assert!(
                error.contains("lectures") || error.contains("non autorisée"),
                "{sql} : {error}"
            );
        }
        assert_eq!(banc.count("texts"), 1);
        assert_eq!(banc.count("badges"), 0);
        assert_eq!(
            banc.read("PRAGMA user_version", vec![]).unwrap()[0]["user_version"],
            2
        );
    }

    #[test]
    fn une_seule_instruction_par_entree() {
        let banc = banc();
        let error = banc
            .read("SELECT 1; DELETE FROM texts", vec![])
            .unwrap_err();
        assert_eq!(error, "Une seule instruction SQL par entrée.");
        let error = banc
            .batch(json!([{ "sql": "DELETE FROM faults; DELETE FROM texts" }]))
            .unwrap_err();
        assert!(error.contains("Une seule instruction"), "{error}");
        assert_eq!(banc.count("texts"), 1);
        assert_eq!(banc.count("faults"), 1);
        // Un commentaire ou un point-virgule final ne compte pas.
        banc.read("SELECT 1 AS un; -- fin", vec![]).unwrap();
        assert!(banc
            .read("  -- rien\n", vec![])
            .unwrap_err()
            .contains("vide"));
    }

    #[test]
    fn attach_detach_et_extensions_sont_impossibles() {
        let banc = banc();
        let autre = banc.path.with_file_name("autre.db");
        let attach = format!("ATTACH DATABASE '{}' AS autre", autre.display());
        assert!(banc.read(&attach, vec![]).is_err());
        assert!(banc
            .batch(json!([{ "sql": attach }]))
            .unwrap_err()
            .contains("non autorisée"));
        assert!(banc
            .batch(json!([{ "sql": "DETACH DATABASE autre" }]))
            .is_err());
        assert!(!autre.exists());

        let error = banc
            .read("SELECT load_extension('/tmp/x.so') AS x", vec![])
            .unwrap_err();
        assert!(error.contains("non autorisée"), "{error}");

        // VACUUM INTO écrirait une copie de la base n'importe où.
        let copie = banc.path.with_file_name("copie.db");
        let vacuum = format!("VACUUM INTO '{}'", copie.display());
        assert!(banc.read(&vacuum, vec![]).unwrap_err().contains("VACUUM"));
        assert!(banc
            .batch(json!([{ "sql": format!("/* x */ vacuum into '{}'", copie.display()) }]))
            .unwrap_err()
            .contains("VACUUM"));
        assert!(!copie.exists());
    }

    #[test]
    fn transactions_et_pragmas_dangereux_sont_refuses() {
        let banc = banc();
        for sql in [
            "BEGIN",
            "COMMIT",
            "ROLLBACK",
            "SAVEPOINT s",
            "RELEASE s",
            "PRAGMA journal_mode = DELETE",
            "PRAGMA foreign_keys = OFF",
            "PRAGMA writable_schema = ON",
            "PRAGMA trusted_schema = ON",
            "PRAGMA schema_version = 1",
            "PRAGMA synchronous = OFF",
            "PRAGMA locking_mode = EXCLUSIVE",
            "PRAGMA secure_delete",
            "PRAGMA wal_checkpoint(TRUNCATE)",
            "CREATE VIRTUAL TABLE v USING fts5(x)",
        ] {
            let lecture = banc.read(sql, vec![]);
            assert!(lecture.is_err(), "db_read a accepté : {sql}");
            let lot = banc.batch(json!([{ "sql": sql }]));
            assert!(lot.is_err(), "db_batch a accepté : {sql}");
        }
        // Les réglages de la connexion n'ont pas bougé.
        assert_eq!(
            banc.read("PRAGMA foreign_keys", vec![]).unwrap()[0]["foreign_keys"],
            1
        );
        assert_eq!(banc.journal_mode(), "wal");
        // Les pragmas d'information restent permis.
        let colonnes = banc.read("PRAGMA table_info(badges)", vec![]).unwrap();
        assert_eq!(colonnes.len(), 2);
        // Et la migration du schéma peut changer sa version.
        banc.batch(json!([{ "sql": "PRAGMA user_version = 3" }]))
            .unwrap();
        assert_eq!(
            banc.read("PRAGMA user_version", vec![]).unwrap()[0]["user_version"],
            3
        );
    }

    #[test]
    fn le_schema_interne_est_protege() {
        let banc = banc();
        for sql in [
            "DELETE FROM sqlite_master",
            "UPDATE sqlite_schema SET sql = 'x' WHERE name = 'texts'",
            "INSERT INTO sqlite_master VALUES ('table', 'x', 'x', 0, 'CREATE TABLE x(y)')",
        ] {
            assert!(banc.batch(json!([{ "sql": sql }])).is_err(), "{sql}");
        }
        let tables = banc
            .read(
                "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
                vec![],
            )
            .unwrap();
        // texts, faults, rule_states, rule_events, badges : intactes.
        assert_eq!(tables.len(), 5);
    }

    #[test]
    fn la_migration_du_schema_passe_par_un_lot() {
        let banc = banc();
        // Ce que fera le pilote TypeScript : CREATE … IF NOT EXISTS, puis version.
        let results = banc
            .batch(json!([
                { "sql": "CREATE TABLE IF NOT EXISTS nouvelle (id INTEGER PRIMARY KEY, x TEXT)" },
                { "sql": "CREATE INDEX IF NOT EXISTS idx_nouvelle ON nouvelle(x)" },
                { "sql": "PRAGMA user_version = 3" },
            ]))
            .unwrap();
        // Aucune ligne modifiée par ces instructions (pas la valeur précédente).
        assert!(results.iter().all(|r| r.changes == 0), "{results:?}");
    }

    #[test]
    fn un_lot_refuse_n_ecrit_rien() {
        let banc = banc();
        let error = banc
            .batch(json!([
                { "sql": "INSERT INTO texts (created_at, word_count, fault_count, unclassified_count) VALUES (?, 1, 0, 0)",
                  "params": [MAINTENANT] },
                { "sql": "INSERT INTO badges (badge_id, obtained_at) VALUES (?, ?)", "params": ["premier", MAINTENANT] },
                // Contrainte NOT NULL violée : tout le lot est annulé.
                { "sql": "INSERT INTO badges (badge_id, obtained_at) VALUES (?, NULL)", "params": ["second"] },
            ]))
            .unwrap_err();
        assert!(error.starts_with("Instruction 2 :"), "{error}");
        assert!(error.ends_with("Lot annulé."), "{error}");
        assert_eq!(banc.count("texts"), 1);
        assert_eq!(banc.count("badges"), 0);

        // Paramètre invalide : refusé avant toute écriture aussi.
        let error = banc
            .batch(json!([
                { "sql": "INSERT INTO badges VALUES ('a', 1)" },
                { "sql": "INSERT INTO badges VALUES (?, ?)", "params": [[1], 2] },
            ]))
            .unwrap_err();
        assert!(error.contains("tableau"), "{error}");
        assert_eq!(banc.count("badges"), 0);

        // La connexion reste utilisable (pas de transaction restée ouverte).
        banc.batch(json!([{ "sql": "INSERT INTO badges VALUES ('a', 1)" }]))
            .unwrap();
        assert_eq!(banc.count("badges"), 1);
    }

    #[test]
    fn rowid_designe_une_ligne_inseree_plus_tot_dans_le_lot() {
        let banc = banc();
        let results = banc
            .batch(json!([
                { "sql": "INSERT INTO texts (created_at, word_count, fault_count, unclassified_count, score) VALUES (?, ?, ?, ?, ?)",
                  "params": [MAINTENANT, 10, 2, 0, null] },
                { "sql": "INSERT INTO faults (text_id, created_at, rule_key, source, category_id, category_name,
                            issue_type, message, word, replacement, sentence, counted)
                          VALUES (?, ?, 'R1', 'lt', 'c', 'n', 'i', 'm', 'w', 'r', 's', ?)",
                  "params": [{ "$rowid": 0 }, MAINTENANT, true] },
                { "sql": "INSERT INTO faults (text_id, created_at, rule_key, source, category_id, category_name,
                            issue_type, message, word, replacement, sentence, counted)
                          VALUES (?, ?, 'R2', 'lt', 'c', 'n', 'i', 'm', 'w', 'r', 's', ?)",
                  "params": [{ "$rowid": 0 }, MAINTENANT, false] },
            ]))
            .unwrap();
        assert_eq!(
            results[0],
            StatementResult {
                changes: 1,
                last_insert_rowid: 2
            }
        );
        assert_eq!(results[1].changes, 1);
        let fautes = banc
            .read(
                "SELECT text_id, counted FROM faults WHERE text_id = ? ORDER BY id",
                vec![json!(2)],
            )
            .unwrap();
        assert_eq!(fautes.len(), 2);
        assert_eq!(fautes[0]["counted"], 1);
        assert_eq!(fautes[1]["counted"], 0);

        // Une instruction ne peut désigner qu'une instruction antérieure.
        for params in [json!([{ "$rowid": 0 }]), json!([{ "$rowid": 5 }])] {
            let error = banc
                .batch(json!([{ "sql": "SELECT ?", "params": params }]))
                .unwrap_err();
            assert!(error.contains("ne précède pas"), "{error}");
        }
        // Hors d'un lot, ou mal formé : refusé.
        assert!(banc
            .read("SELECT ?", vec![json!({ "$rowid": 0 })])
            .unwrap_err()
            .contains("lot"));
        let error = banc
            .batch(json!([{ "sql": "SELECT 1" }, { "sql": "SELECT ?", "params": [{ "$rowid": 0, "x": 1 }] }]))
            .unwrap_err();
        assert!(error.contains("objet inconnu"), "{error}");
    }

    #[test]
    fn expect_changes_annule_le_lot_en_cas_de_conflit() {
        let banc = banc();
        let repondre = |etat: &str| {
            json!([
                { "sql": "INSERT INTO rule_events (rule_key, created_at, type) VALUES ('R', ?, 'reponse_juste')",
                  "params": [MAINTENANT] },
                { "sql": "UPDATE rule_states SET state = ? WHERE rule_key = 'R' AND state = 'en_cours'",
                  "params": [etat], "expectChanges": 1 },
            ])
        };
        // Aucune règle « en_cours » : l'UPDATE ne touche rien, le lot est annulé.
        let error = banc.batch(repondre("acquise")).unwrap_err();
        assert!(
            error.starts_with("Conflit : l'instruction 1 a modifié 0 ligne(s), 1 attendue(s)."),
            "{error}"
        );
        assert_eq!(banc.count("rule_events"), 0);

        banc.batch(json!([{
            "sql": "INSERT INTO rule_states (rule_key, state, state_since, occurrences, first_fault_at, last_fault_at)
                    VALUES ('R', 'en_cours', 0, 1, 0, 0)"
        }]))
        .unwrap();
        let results = banc.batch(repondre("acquise")).unwrap();
        assert_eq!(results[1].changes, 1);
        assert_eq!(banc.count("rule_events"), 1);
        // Deuxième réponse : la règle n'est plus « en_cours », conflit.
        assert!(banc
            .batch(repondre("acquise"))
            .unwrap_err()
            .starts_with("Conflit"));
        assert_eq!(banc.count("rule_events"), 1);
        // expectChanges: 0 est une garde valable aussi.
        banc.batch(json!([{ "sql": "DELETE FROM badges", "expectChanges": 0 }]))
            .unwrap();
    }

    #[test]
    fn read_many_lit_un_seul_instantane() {
        let banc = banc();
        let queries: Vec<Query> = serde_json::from_value(json!([
            { "sql": "SELECT COUNT(*) AS n FROM texts" },
            { "sql": "SELECT word FROM faults WHERE created_at = ?", "params": [MAINTENANT] },
        ]))
        .unwrap();
        let results = banc.db.with(|g| read_many(g, &queries)).unwrap();
        assert_eq!(results[0][0]["n"], 1);
        assert_eq!(results[1][0]["word"], "mangé");
        // Les mêmes garde-fous qu'une lecture simple.
        let ecriture: Vec<Query> =
            serde_json::from_value(json!([{ "sql": "SELECT 1" }, { "sql": "DELETE FROM texts" }]))
                .unwrap();
        assert!(banc.db.with(|g| read_many(g, &ecriture)).is_err());
        assert_eq!(banc.count("texts"), 1);
    }

    #[test]
    fn les_types_json_et_sqlite_se_correspondent() {
        let banc = banc();
        let rows = banc
            .read(
                "SELECT ? AS entier, ? AS reel, ? AS texte, ? AS nul, ? AS vrai, ? AS grand",
                vec![
                    json!(MAINTENANT),
                    json!(0.1),
                    json!("« é » 😀"),
                    Value::Null,
                    json!(true),
                    json!(9_007_199_254_740_991_i64),
                ],
            )
            .unwrap();
        let row = &rows[0];
        assert_eq!(row["entier"], json!(MAINTENANT));
        assert_eq!(row["reel"], json!(0.1));
        assert_eq!(row["texte"], "« é » 😀");
        assert!(row["nul"].is_null());
        assert_eq!(row["vrai"], 1);
        // Les entiers sortent chiffre pour chiffre : jusqu'à 2^53 − 1
        // (Number.MAX_SAFE_INTEGER), JSON.parse les relit exactement.
        let texte = serde_json::to_string(row).unwrap();
        assert!(texte.contains("\"entier\":1795000000000"), "{texte}");
        assert!(texte.contains("\"grand\":9007199254740991"), "{texte}");
        // 64 bits complets côté SQLite (le texte JSON reste exact).
        let max = banc
            .read("SELECT 9223372036854775807 AS m", vec![])
            .unwrap();
        assert_eq!(
            serde_json::to_string(&max[0]).unwrap(),
            "{\"m\":9223372036854775807}"
        );

        // Paramètres refusés proprement.
        assert!(banc
            .read("SELECT ?", vec![json!(u64::MAX)])
            .unwrap_err()
            .contains("64 bits"));
        assert!(banc.read("SELECT ?", vec![json!([1])]).is_err());
        // Colonnes BLOB refusées avec un message clair.
        let error = banc.read("SELECT x'00ff' AS donnees", vec![]).unwrap_err();
        assert_eq!(
            error,
            "Colonne « donnees » : les BLOB ne sont pas pris en charge."
        );
        let error = banc.read("SELECT 9e999 AS infini", vec![]).unwrap_err();
        assert!(error.contains("non fini"), "{error}");
        // Nombre de paramètres incorrect : erreur, pas de valeur inventée.
        assert!(banc.read("SELECT ? AS a, ? AS b", vec![json!(1)]).is_err());
    }
}
