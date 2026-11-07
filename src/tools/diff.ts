import pc from 'picocolors';

type Op = { kind: ' ' | '-' | '+'; text: string; oldNo?: number; newNo?: number };

/**
 * Line diff. Edits are usually local, so trim the common prefix/suffix and run
 * an LCS only on the changed middle (capped, falling back to replace-all).
 */
export function diffLines(before: string, after: string): Op[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: ' ', text: a[i], oldNo: i + 1, newNo: i + 1 });

  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length * mb.length > 4_000_000) {
    ma.forEach((t, i) => ops.push({ kind: '-', text: t, oldNo: start + i + 1 }));
    mb.forEach((t, i) => ops.push({ kind: '+', text: t, newNo: start + i + 1 }));
  } else {
    // classic DP LCS on the middle section
    const n = ma.length;
    const m = mb.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = ma[i] === mb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        ops.push({ kind: ' ', text: ma[i], oldNo: start + i + 1, newNo: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) {
        // prefer deletions first so a change reads "- old / + new"
        ops.push({ kind: '-', text: ma[i], oldNo: start + i + 1 });
        i++;
      } else {
        ops.push({ kind: '+', text: mb[j], newNo: start + j + 1 });
        j++;
      }
    }
  }
  const offset = endB - endA;
  for (let i = endA; i < a.length; i++) ops.push({ kind: ' ', text: a[i], oldNo: i + 1, newNo: i + 1 + offset });
  return ops;
}

/** Render changed hunks with `context` lines around them, colored, with line numbers. */
export function renderDiff(before: string, after: string, context = 3, maxLines = 80): string {
  const ops = diffLines(before, after);
  const changed = ops.map((o) => o.kind !== ' ');
  const keep = ops.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) if (changed[k]) return true;
    return false;
  });
  const width = String(Math.max(before.split('\n').length, after.split('\n').length)).length;
  const lines: string[] = [];
  let skipped = false;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) {
      skipped = true;
      continue;
    }
    if (skipped && lines.length) lines.push(pc.dim(' '.repeat(width) + ' ⋮'));
    skipped = false;
    const o = ops[i];
    const no = String(o.kind === '+' ? o.newNo : o.oldNo).padStart(width);
    if (o.kind === '-') lines.push(pc.red(`${no} - ${o.text}`));
    else if (o.kind === '+') lines.push(pc.green(`${no} + ${o.text}`));
    else lines.push(pc.dim(`${no}   ${o.text}`));
  }
  if (lines.length > maxLines) {
    const rest = lines.length - maxLines;
    return [...lines.slice(0, maxLines), pc.dim(`… ${rest} more diff lines`)].join('\n');
  }
  return lines.join('\n');
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const o of diffLines(before, after)) {
    if (o.kind === '+') added++;
    else if (o.kind === '-') removed++;
  }
  return { added, removed };
}
