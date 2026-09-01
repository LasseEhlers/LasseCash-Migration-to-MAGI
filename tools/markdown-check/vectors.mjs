import { renderMarkdown as R } from "./md.mjs";
let fail = 0;
const bad = (name, md, forbidden) => {
  const out = R(md);
  const hit = forbidden.find((f) => out.toLowerCase().includes(f.toLowerCase()));
  if (hit) { console.log(`  XSS FAIL  ${name}\n            found ${JSON.stringify(hit)} in: ${out.slice(0,140)}`); fail++; }
  else console.log(`  blocked   ${name}`);
};
const good = (name, md, expected) => {
  const out = R(md);
  if (!out.includes(expected)) { console.log(`  BROKE     ${name}\n            want ${expected}\n            got  ${out.slice(0,160)}`); fail++; }
  else console.log(`  renders   ${name}`);
};

console.log("ATTACK VECTORS");
bad("script tag",            `<script>alert(1)</script>`,                 ["<script"]);
bad("img onerror",           `<img src=x onerror=alert(1)>`,              ["onerror"]);
bad("javascript: href",      `<a href="javascript:alert(1)">x</a>`,       ["javascript:"]);
bad("data: image",           `<img src="data:text/html,<script>">`,       ["data:"]);
bad("iframe",                `<iframe src="https://evil.com"></iframe>`,  ["<iframe"]);
bad("style attribute",       `<div style="position:fixed">x</div>`,       ["style="]);
bad("onclick",               `<div onclick="alert(1)">x</div>`,           ["onclick"]);
bad("svg onload",            `<svg onload=alert(1)>`,                     ["<svg", "onload"]);
bad("uppercase SCRIPT",      `<SCRIPT>alert(1)</SCRIPT>`,                 ["<script"]);
bad("nested quotes in href", `<a href="https://a.com" onmouseover="x">`,  ["onmouseover"]);
bad("form",                  `<form action=/><input name=p></form>`,      ["<form", "<input"]);
bad("object/embed",          `<object data=x></object><embed src=y>`,     ["<object", "<embed"]);

console.log("\nREAL CONTENT (must still render)");
good("center",   `<center>hello</center>`,                       "<center>");
good("table",    `<table><tr><td>a</td></tr></table>`,           "<table>");
good("img https",`<img src="https://images.hive.blog/a.png">`,   `<img src="https://images.hive.blog/a.png"`);
good("link",     `<a href="https://peakd.com/x">y</a>`,          `href="https://peakd.com/x"`);
good("url amp",  `<a href="https://x.com/a?b=1&amp;c=2">y</a>`,  `b=1&amp;c=2`);
good("bold/br",  `<b>bold</b><br>`,                              "<b>bold</b>");
good("markdown", `**still** works`,                              "<strong>still</strong>");
good("code kept","```\n<script>x</script>\n```",                 "&lt;script&gt;");

console.log(fail ? `\n${fail} FAILURES` : "\nall clear");
