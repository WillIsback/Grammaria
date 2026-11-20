/**
 * Corrigés de référence du corpus du correcteur (tests/fixtures/correcteur/corpus.ts), écrits à
 * la main : ce qu'un bon correcteur rendrait, sans reformulation. Ils tiennent lieu de réponse
 * du modèle de langage pour comparer deux moteurs grammaticaux à réponse du modèle égale
 * (scripts/comparaison/rapport.ts) : l'application ne retient une détection que si le passage a
 * réellement été corrigé.
 *
 * Les textes composés (« long », « tres-long ») sont recomposés à partir des autres, comme
 * dans le corpus.
 */
import { CORPUS } from "../../tests/fixtures/correcteur/corpus.ts";

const CORRIGES_SIMPLES: Record<string, string> = {
  "marche-160-mots": `Hier, je suis allé au marché avec mes amis pour acheter des légumes frais. Il faisait beau et les gens étaient nombreux dans les allées. Nous avons trouvé des tomates magnifiques, mais elles coûtaient trop cher pour notre budget. Ma sœur a dit qu'elle préférait les courgettes, parce qu'elles sont plus faciles à cuisiner. Ensuite, nous sommes allés boire un café sur la place principale. Le serveur nous a apporté des croissants que nous n'avions pas commandés. J'ai essayé de lui expliquer, mais il ne comprenait pas bien le français. Finalement, nous avons ri de la situation et nous avons gardé les croissants. En rentrant, j'ai réalisé que j'avais oublié mon portefeuille sur la table du café. Heureusement, le serveur l'avait mis de côté et me l'a rendu avec un grand sourire. Cette journée m'a rappelé que les petites erreurs peuvent parfois créer de beaux souvenirs. La semaine prochaine, nous retournerons au même marché, si le temps le permet.`,
  "courriel-pro": `Bonjour Madame, je vous écris suite à notre réunion de mardi dernier. Comme convenu, je vous envoie le compte rendu ainsi que les documents demandés. Les chiffres du trimestre sont meilleurs que prévu, bien que certains clients aient annulé leur commande. Je reste à votre disposition pour tout renseignement complémentaire. Dans l'attente de votre retour, je vous prie d'agréer mes salutations distinguées.`,
  accords: `Les enfants étaient contents de leurs vacances. Ils ont mangé des glaces et ils se sont baignés tous les jours. Leurs parents, eux, sont restés à l'ombre. La petite fille que j'ai vue hier portait une robe bleue. Quel que soit le temps, ils sortent se promener.`,
  homophones: `Ça fait longtemps que je ne t'ai pas vu. Où est-ce que tu habites maintenant ? On m'a dit que tu as déménagé près de la mer. C'est vraiment dommage que tu ne sois pas venu à la fête, on s'est bien amusés. Je ne sais pas si tu peux venir ce week-end, mais ça me ferait plaisir.`,
  "sans-faute": `Le conseil municipal s'est réuni hier soir pour examiner le budget de l'année prochaine. Après deux heures de débat, les élus ont adopté le texte à une large majorité. Les travaux de la médiathèque commenceront au printemps.`,
  typographie: `Est-ce que tu viens demain ? Je ne sais pas, peut-être… Il a dit : « non ». Le prix est de 12,5 euros, et c'est trop cher ! Il y a deux espaces ici. Au début d'une phrase sans majuscule.`,
  conjugaison: `Si j'avais su, je ne serais pas venu. Il faut que tu viennes me voir avant que je parte. Nous avons décidé de partir tôt, bien que la route soit longue. Je vous saurais gré de bien vouloir me répondre. Elle s'est levée tôt et a pris le train.`,
  court: `Je mange une pomme.`,
  vide: "",
  blancs: "   \n\t  \n",
  "apostrophes-typographiques": `L’enfant n’a pas compris qu’il fallait venir. Aujourd’hui, c’est l’heure d’aller à l’école. Je crois qu’il viendra jusqu’à ce soir. Qu’en penses-tu ? C'est l’été qu’on préfère.`,
  emojis: `Je suis trop content 😀 de te voir ! On se voit demain 👍 ? Les filles sont arrivées 🎉 avec leurs parents 👨‍👩‍👧. C'est vraiment génial 🇫🇷 et ça me fait plaisir ❤️.`,
  majuscules: `PARIS EST UNE BELLE VILLE. Je suis allé à Paris en juillet avec Marie et Jean. LES ENFANTS ÉTAIENT CONTENTS DE LEURS VACANCES. Le lundi, nous visitons le musée du Louvre. État, École et Église s'écrivent avec un accent.`,
  ponctuation: `« Bonjour », dit-il… Puis il ajouta : « tu viens ? » — Oui ! répondit-elle. Il y avait : des pommes ; des poires, et des cerises. Le magasin ferme à 19h00 ! Vraiment ?! (enfin, je crois.) Voici une liste - premier point - deuxième point.`,
  "dates-chiffres-adresses": `Le lundi 3 mars 2026, nous avons rendez-vous à 14 h 30. Le 31 février 2025 n'existe pas. J'ai 3 chats et 2,5 kg de pommes. Écris-moi à jean.dupont@example.com ou va sur https://example.com/page?x=1 pour t'inscrire. Il a gagné 1 000 000 d'euros en 1999.`,
  "lignes-et-liste": `Liste des courses :\n- du pain\n- des œufs\n- du lait demi-écrémé\n\nNe pas oublier les piles pour la télécommande.\nMerci d'avance !`,
  "sans-faute-long": `La bibliothèque de quartier a rouvert ses portes après six mois de travaux. Les lecteurs y découvrent des salles plus lumineuses, des fauteuils confortables et un espace réservé aux enfants, où des animatrices proposent chaque mercredi des lectures à voix haute. Le fonds a été enrichi de plusieurs milliers d'ouvrages, parmi lesquels des romans récents, des bandes dessinées et des livres en langues étrangères. Les horaires ont également été élargis : la bibliothèque est désormais ouverte le dimanche matin, ce que de nombreux habitants réclamaient depuis longtemps. Selon la directrice, la fréquentation a doublé dès la première semaine. Elle espère que ce succès durera et que les nouveaux inscrits prendront l'habitude de revenir régulièrement. Un club de lecture se réunira une fois par mois pour discuter d'un livre choisi ensemble.`,
  recit: `Le train de sept heures était encore en retard ce matin. Sur le quai, les voyageurs regardaient leurs montres en soupirant, et quelques-uns téléphonaient déjà à leur bureau pour prévenir. Une dame âgée, assise sur un banc, racontait à qui voulait l'entendre que de son temps, les trains partaient toujours à l'heure. Un jeune homme lui a répondu poliment qu'il en doutait, ce qui l'a fait rire. Quand le train est enfin arrivé, tout le monde s'est précipité vers les portes. J'ai trouvé une place près de la fenêtre et j'ai regardé défiler les champs encore couverts de brume. Le contrôleur est passé, il a vérifié les billets et il nous a souhaité une bonne journée malgré le retard. Arrivée en ville, j'ai marché jusqu'au bureau en passant par le parc, où les jardiniers plantaient des tulipes pour le printemps.`,
};

const PROTOTYPE = CORPUS.slice(0, 8).map((t) => t.nom);
const AJOUTS = CORPUS.slice(9, -1).map((t) => t.nom);

/** Recompose « long » et « tres-long » comme le corpus, à partir d'une table nom → texte. */
function composer(textes: Record<string, string>): Record<string, string> {
  const texte = (nom: string): string => {
    const t = textes[nom];
    if (t === undefined) throw new Error(`Texte « ${nom} » absent`);
    return t;
  };
  const prototype = PROTOTYPE.map(texte);
  const base = [...prototype, ...AJOUTS.map(texte).filter((t) => t.trim().length > 40)];
  return {
    ...textes,
    long: [...prototype, ...prototype].join("\n\n"),
    "tres-long": [...base, texte("recit")].join("\n\n"),
  };
}

// Garde : la recomposition des originaux doit redonner le corpus, sinon les corrigés des
// textes composés ne correspondraient pas à leurs originaux.
const originaux = composer(
  Object.fromEntries(
    CORPUS.filter((t) => t.nom !== "long" && t.nom !== "tres-long").map((t) => [t.nom, t.texte]),
  ),
);
for (const { nom, texte } of CORPUS) {
  if (originaux[nom] !== texte) throw new Error(`Recomposition du corpus incorrecte : « ${nom} »`);
}

/** Corrigé de chaque texte du corpus, par nom. */
export const CORRIGES: Record<string, string> = composer(CORRIGES_SIMPLES);
