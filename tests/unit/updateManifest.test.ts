import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { buildUpdateManifest } from "../../scripts/desktop/update-manifest";

const root = join(import.meta.dirname, "../..");

const signatures = [
  { name: "Grammaria_0.3.0_amd64.AppImage.sig", signature: "c2lnLWxpbnV4\n" },
  { name: "Grammaria_0.3.0_x64-setup.exe.sig", signature: "c2lnLXdpbmRvd3M=\n" },
];
const options = {
  tag: "v0.3.0",
  repository: "WillIsback/Grammaria",
  signatures,
  pubDate: new Date("2026-11-19T10:00:00Z"),
};

// Issue #13 : manifeste lu par l'application de bureau pour se mettre à jour.
describe("manifeste de mise à jour (latest.json)", () => {
  it("annonce la version et les paquets NSIS et AppImage de la release", () => {
    const manifest = buildUpdateManifest(options);
    expect(manifest.version).toBe("0.3.0");
    expect(manifest.pub_date).toBe("2026-11-19T10:00:00.000Z");
    expect(manifest.platforms["linux-x86_64"]).toEqual({
      signature: "c2lnLWxpbnV4",
      url: "https://github.com/WillIsback/Grammaria/releases/download/v0.3.0/Grammaria_0.3.0_amd64.AppImage",
    });
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: "c2lnLXdpbmRvd3M=",
      url: "https://github.com/WillIsback/Grammaria/releases/download/v0.3.0/Grammaria_0.3.0_x64-setup.exe",
    });
    // Clés précises, cherchées en premier par l'application.
    expect(manifest.platforms["linux-x86_64-appimage"]).toEqual(manifest.platforms["linux-x86_64"]);
    expect(manifest.platforms["windows-x86_64-nsis"]).toEqual(manifest.platforms["windows-x86_64"]);
  });

  it("n'y met ni le MSI ni le .deb, qui ne se mettent pas à jour seuls", () => {
    const manifest = buildUpdateManifest({
      ...options,
      signatures: [
        ...signatures,
        { name: "Grammaria_0.3.0_x64_fr-FR.msi.sig", signature: "bXNp" },
        { name: "Grammaria_0.3.0_amd64.deb.sig", signature: "ZGVi" },
      ],
    });
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      "linux-x86_64",
      "linux-x86_64-appimage",
      "windows-x86_64",
      "windows-x86_64-nsis",
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/\.msi|\.deb/);
  });

  it("refuse une pré-version : elle n'est jamais proposée aux utilisateurs", () => {
    for (const tag of ["v0.3.0-rc.1", "v0.3.0-1", "v0.3.0-alpha.2"]) {
      expect(() => buildUpdateManifest({ ...options, tag })).toThrow(/version stable/);
    }
  });

  it("refuse une release incomplète ou une signature vide", () => {
    expect(() => buildUpdateManifest({ ...options, signatures: [signatures[0]] })).toThrow(
      /absente pour : windows/,
    );
    expect(() => buildUpdateManifest({ ...options, signatures: [] })).toThrow(
      /absente pour : linux, windows/,
    );
    expect(() =>
      buildUpdateManifest({
        ...options,
        signatures: [signatures[0], { name: signatures[1].name, signature: " \n" }],
      }),
    ).toThrow(/Signature vide/);
  });
});

// Garde-fous de configuration : ce que les workflows et l'application supposent.
describe("configuration de la mise à jour automatique", () => {
  const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf-8"));
  const build = readFileSync(join(root, ".github/workflows/build-desktop.yml"), "utf-8");
  const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf-8");

  it("lit le manifeste sur la dernière release stable, en HTTPS", () => {
    expect(conf.plugins.updater.endpoints).toEqual([
      "https://github.com/WillIsback/Grammaria/releases/latest/download/latest.json",
    ]);
    expect(typeof conf.plugins.updater.pubkey).toBe("string");
    expect(conf.plugins.updater.requireSignedVersion).toBe(true);
  });

  it("ne contient jamais de clé privée", () => {
    // Une clé publique minisign encodée commence par « dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk » ;
    // une clé privée, par « …IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5 » (rsign encrypted secret key).
    const decoded = Buffer.from(conf.plugins.updater.pubkey, "base64").toString("utf-8");
    expect(decoded).not.toMatch(/secret key/i);
  });

  it("garde le build vert sans clé : les artefacts de mise à jour ne sont activés que par le workflow", () => {
    expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();
    expect(build).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY != ''");
    expect(build).toContain('"createUpdaterArtifacts": true');
  });

  it("n'écrit le manifeste que pour une version stable", () => {
    const step = release.slice(release.indexOf("- name: Manifeste de mise à jour"));
    expect(step.slice(0, 200)).toContain("if: env.PRERELEASE != 'true'");
    expect(step).toContain("scripts/desktop/update-manifest.ts");
  });
});
