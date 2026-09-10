const chunks = new Map();

const stopWords = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then",
  "如果", "以及", "进行", "当前", "需要", "可以", "一个", "没有", "相关",
]);

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

export function chunkDocument(content, size = 680) {
  const normalized = String(content || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/);
  const result = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }
    if ((current + "\n\n" + paragraph).length <= size) {
      current += `\n\n${paragraph}`;
    } else {
      result.push(current);
      current = paragraph;
    }
  }
  if (current) result.push(current);
  return result.flatMap((item) => {
    if (item.length <= size) return [item];
    const parts = [];
    for (let index = 0; index < item.length; index += size) parts.push(item.slice(index, index + size));
    return parts;
  });
}

export function indexSkill(skill) {
  for (const [id, chunk] of chunks) {
    if (chunk.skillId === skill.id) chunks.delete(id);
  }
  const pieces = chunkDocument(skill.content);
  pieces.forEach((content, index) => {
    const id = `${skill.id}-chunk-${index + 1}`;
    chunks.set(id, {
      id,
      skillId: skill.id,
      version: skill.version,
      title: skill.title,
      ownerUserId: String(skill.ownerUserId || ""),
      content,
      tags: skill.tags || [],
      status: skill.status,
      tokens: new Set(tokenize(`${skill.title} ${content} ${(skill.tags || []).join(" ")}`)),
    });
  });
  return pieces.length;
}

export function searchKnowledge(query, filters = {}, limit = 5) {
  const queryTokens = new Set(tokenize(query));
  const matches = [];
  for (const chunk of chunks.values()) {
    if (chunk.status !== "APPROVED") continue;
    if (filters.ownerUserId && chunk.ownerUserId && chunk.ownerUserId !== String(filters.ownerUserId)) continue;
    if (filters.skillId && filters.skillId !== chunk.skillId) continue;
    if (filters.tag && !chunk.tags.includes(filters.tag)) continue;
    let overlap = 0;
    for (const token of queryTokens) if (chunk.tokens.has(token)) overlap += 1;
    if (overlap === 0 && queryTokens.size > 0) continue;
    const score = queryTokens.size ? overlap / queryTokens.size : 0.1;
    matches.push({
      chunkId: chunk.id,
      skillId: chunk.skillId,
      version: chunk.version,
      title: chunk.title,
      excerpt: chunk.content.slice(0, 220),
      score: Number(score.toFixed(2)),
      evidenceId: `evidence:${chunk.id}`,
    });
  }
  return matches.sort((left, right) => right.score - left.score).slice(0, limit);
}

export function getRagStats() {
  return { indexedChunks: chunks.size, mode: "local-keyword", vectorProvider: "pluggable" };
}
