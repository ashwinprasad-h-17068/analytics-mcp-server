export function parseCSVData(csvData: string): { columns: string[], rows: Record<string, string>[] } {
  const lines = csvData.split('\n');
  if (lines.length <= 1) {
    return { columns: [], rows: [] };
  }
  const columns = lines[0].split(',').map((col: string) => col.trim().replace(/^"|"$/g, ''));
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue; // Skip empty lines
    const values = lines[i].split(',').map(val => val.trim().replace(/^"|"$/g, ''));
    if (values.length === columns.length) {
      const row: Record<string, string> = {};
      columns.forEach((col: string, index: number) => {
        row[col] = values[index];
      });
      rows.push(row);
    }
  }
  return { columns, rows };
}

export function inferDataType(value: string): "PLAIN" | "NUMBER" | "DATE" {
  if (!isNaN(parseFloat(value)) && isFinite(Number(value))) {
    return 'NUMBER';
  }
  const dateRegex = /^\d{4}[-/](0?[1-9]|1[012])[-/](0?[1-9]|[12][0-9]|3[01])$/;
  const dateRegex2 = /^(0?[1-9]|1[012])[-/](0?[1-9]|[12][0-9]|3[01])[-/]\d{4}$/;
  if (dateRegex.test(value) || dateRegex2.test(value) || !isNaN(Date.parse(value))) {
    return 'DATE';
  }
  return 'PLAIN';
}
