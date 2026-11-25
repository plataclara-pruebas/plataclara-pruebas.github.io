// Extrae el JavaScript embebido en los .html (y copia los .js) a .seguridad/build/ para analizarlo.
// Así los escáneres no omiten el ~90 % del código, que vive dentro de index.html.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const AQUI = path.dirname(fileURLToPath(import.meta.url)), RAIZ = path.join(AQUI, '..'), OUT = path.join(AQUI, 'build');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(RAIZ)) {
  const p = path.join(RAIZ, f);
  if (!fs.statSync(p).isFile()) continue;
  if (f.endsWith('.js')) fs.copyFileSync(p, path.join(OUT, f));
  if (f.endsWith('.html')) {
    const h = fs.readFileSync(p, 'utf8'); const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m, n = 0;
    while ((m = re.exec(h))) { const linea = h.slice(0, m.index).split('\n').length; fs.writeFileSync(path.join(OUT, `${f}.inline-${++n}.L${linea}.js`), m[1]); }
    console.log(`${f}: ${n} bloques <script> inline extraídos`);
  }
}
