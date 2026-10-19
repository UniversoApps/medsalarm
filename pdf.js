/* Generador de PDF propio, sin dependencias (funciona sin conexión).
   Reproduce el diseño del PDF de la app Android: A4, título, período, tabla
   Fecha y hora | Medicamento | Dosis, observaciones debajo y número de página. */
const MedsPdf = (() => {
  // Anchos de Helvetica (unidades de 1/1000) para ASCII 32..126
  const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
    556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,
    667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
    278,278,278,469,556,333,
    556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,
    334,260,334,584];
  const SPECIAL = { "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92, "“": 0x93,
    "”": 0x94, "•": 0x95, "…": 0x85, "€": 0x80, "«": 0xAB, "»": 0xBB };

  function baseChar(ch) {
    const b = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return b.length ? b[0] : ch;
  }
  function charWidth(ch) {
    let c = ch.charCodeAt(0);
    if (c < 32 || c > 126) { const b = baseChar(ch); c = b.charCodeAt(0); }
    if (c >= 32 && c <= 126) return W[c - 32];
    if (SPECIAL[ch] === 0x96) return 556;
    if (SPECIAL[ch] === 0x97) return 1000;
    return 556;
  }
  function textWidth(s, size, bold) {
    let w = 0;
    for (const ch of s) w += charWidth(ch);
    return (w / 1000) * size * (bold ? 1.06 : 1);
  }
  function encode(s) {
    let out = "";
    for (const ch of s) {
      const c = ch.codePointAt(0);
      let code;
      if (SPECIAL[ch] !== undefined) code = SPECIAL[ch];
      else if (c >= 32 && c <= 126) code = c;
      else if (c >= 0xA0 && c <= 0xFF) code = c;
      else { const b = baseChar(ch).charCodeAt(0); code = (b >= 32 && b <= 126) ? b : 63; }
      const chr = String.fromCharCode(code);
      out += (chr === "(" || chr === ")" || chr === "\\") ? "\\" + chr : chr;
    }
    return out;
  }
  function wrap(text, size, maxW) {
    const lines = [];
    for (const para of String(text).split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        const cand = line ? line + " " + word : word;
        if (textWidth(cand, size) <= maxW) { line = cand; continue; }
        if (line) lines.push(line);
        let rest = word;
        while (textWidth(rest, size) > maxW && rest.length > 1) {
          let n = rest.length;
          while (n > 1 && textWidth(rest.slice(0, n), size) > maxW) n--;
          lines.push(rest.slice(0, n));
          rest = rest.slice(n);
        }
        line = rest;
      }
      lines.push(line);
    }
    return lines;
  }
  const rgb = (hex) => [1, 3, 5].map(i => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");

  /**
   * opts: { title, period, generated, total, headers:[3], rows:[{when,name,dose,notes}],
   *         notesPrefix(fn), pageLabel(fn), emptyText }
   */
  function build(opts) {
    const pageW = 595, pageH = 842, margin = 40;
    const x0 = margin, x1 = margin + 120, x2 = margin + 320;
    const w1 = x2 - x1 - 10, w2 = pageW - margin - x2, noteW = pageW - margin - x1;
    const bottomLimit = pageH - margin - 16, lineH = 14, smallH = 12;
    const TEAL = rgb("#0B4F4A"), GREY = rgb("#555555"), INK = rgb("#111111"), NOTE = rgb("#666666"), RULE = rgb("#CCCCCC");

    const pages = [];
    let ops = null, y = 0;
    const Y = (v) => (pageH - v).toFixed(2);
    const text = (s, x, yy, size, color, bold) => {
      ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${color} rg ${x.toFixed(2)} ${Y(yy)} Td (${encode(s)}) Tj ET`);
    };
    const hline = (yy) => ops.push(`${RULE} RG 0.7 w ${margin} ${Y(yy)} m ${pageW - margin} ${Y(yy)} l S`);
    const finishPage = () => {
      if (!ops) return;
      text(opts.pageLabel(pages.length + 1), margin, pageH - margin + 8, 9.5, NOTE);
      pages.push(ops.join("\n"));
      ops = null;
    };
    const newPage = () => { finishPage(); ops = []; y = margin; };
    const tableHeader = () => {
      y += 12;
      text(opts.headers[0], x0, y, 11, TEAL, true);
      text(opts.headers[1], x1, y, 11, TEAL, true);
      text(opts.headers[2], x2, y, 11, TEAL, true);
      y += 6; hline(y); y += 6;
    };

    newPage();
    y += 20; text(opts.title, margin, y, 20, TEAL, true);
    y += 20; text(opts.period, margin, y, 11, GREY);
    y += 15; text(opts.generated, margin, y, 11, GREY);
    y += 15; text(opts.total, margin, y, 11, GREY);
    y += 14; tableHeader();
    if (!opts.rows.length) { y += 14; text(opts.emptyText, margin, y, 11, INK); }

    for (const r of opts.rows) {
      const nameLines = wrap(r.name, 11, w1);
      const doseLines = wrap(r.dose || "—", 11, w2);
      const noteLines = r.notes ? wrap(opts.notesPrefix(r.notes), 9.5, noteW) : [];
      const rows = Math.max(nameLines.length, doseLines.length);
      const height = rows * lineH + noteLines.length * smallH + 10;
      if (y + height > bottomLimit) { newPage(); tableHeader(); }
      const top = y;
      text(r.when, x0, top + 11, 11, INK);
      nameLines.forEach((l, i) => text(l, x1, top + 11 + i * lineH, 11, INK));
      doseLines.forEach((l, i) => text(l, x2, top + 11 + i * lineH, 11, INK));
      const noteTop = top + rows * lineH + 8;
      noteLines.forEach((l, i) => text(l, x1, noteTop + i * smallH, 9.5, NOTE));
      y = top + height;
      hline(y - 4);
    }
    finishPage();

    // Ensamblado del archivo PDF (1 carácter = 1 byte, WinAnsi)
    const objs = [];
    const add = (s) => { objs.push(s); return objs.length; };
    const catalogId = add(null), pagesId = add(null);
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids = [];
    for (const content of pages) {
      const cId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cId} 0 R >>`));
    }
    objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
    const infoId = add(`<< /Title (${encode(opts.title)}) /Producer (MedsAlarm) >>`);

    let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach(o => { pdf += String(o).padStart(10, "0") + " 00000 n \n"; });
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xFF;
    return bytes;
  }
  return { build };
})();
