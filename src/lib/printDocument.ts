function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const baseStyles = `
  * { box-sizing: border-box; }
  body {
    font-family: "Lexend", "Avenir Next", "Avenir", "Century Gothic", system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #12172a;
    margin: 0;
    padding: 40px 48px;
  }
  .doc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 3px solid #0e1835;
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  .doc-brand {
    font-family: inherit;
    font-weight: 700;
    font-size: 20px;
    color: #0e1835;
  }
  .doc-title { text-align: right; }
  .doc-title h1 { margin: 0; font-size: 16px; font-weight: 700; }
  .doc-title p { margin: 2px 0 0; font-size: 12px; color: #4c5568; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 8px 4px; font-size: 13px; }
  th { text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; color: #7d8496; border-bottom: 2px solid #dde1d6; }
  td { border-bottom: 1px solid #eceee7; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px 24px; margin-bottom: 20px; }
  .meta-grid div span { display: block; }
  .meta-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #7d8496; }
  .meta-value { font-size: 13px; font-weight: 700; margin-top: 2px; }
  .total-row td { font-weight: 700; border-top: 2px solid #0e1835; border-bottom: none; padding-top: 12px; }
  .cert-body { font-size: 13.5px; line-height: 1.7; margin: 0 0 14px; }
  .doc-footer { margin-top: 32px; font-size: 11px; color: #7d8496; }
  @media print {
    body { padding: 0 24px; }
  }
`;

export function openPrintDocument(title: string, bodyHtml: string) {
  const win = window.open("", "_blank", "width=850,height=1100");
  if (!win) return;
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lexend:wght@300..700&amp;display=swap"><style>${baseStyles}</style></head><body>${bodyHtml}</body></html>`,
  );
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

export { escapeHtml };
