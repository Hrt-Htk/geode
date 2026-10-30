const newVersion = Deno.args[0];
if (!newVersion) {
  console.error("Usage: deno run -A scripts/version-bump.ts <newversion>");
  Deno.exit(1);
}

const root = Deno.cwd();

// 1. manifest.json
const manifestPath = `${root}/manifest.json`;
const manifestText = await Deno.readTextFile(manifestPath);
const manifest = JSON.parse(manifestText);
manifest.version = newVersion;
const minAppVersion = manifest.minAppVersion;
await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// 2. versions.json
const versionsPath = `${root}/versions.json`;
const versionsText = await Deno.readTextFile(versionsPath);
const versions = JSON.parse(versionsText);
versions[newVersion] = minAppVersion;
await Deno.writeTextFile(versionsPath, JSON.stringify(versions, null, 2) + "\n");

// 3. package.json
const packagePath = `${root}/package.json`;
const packageText = await Deno.readTextFile(packagePath);
const pkg = JSON.parse(packageText);
pkg.version = newVersion;
await Deno.writeTextFile(packagePath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`Updated: manifest.json (version: ${newVersion})`);
console.log(`Updated: versions.json (added ${newVersion} -> ${minAppVersion})`);
console.log(`Updated: package.json (version: ${newVersion})`);
