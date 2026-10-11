export type Word = {
  id: string;
  term: string;
  meaning: string;
};

export function removeBuiltInWords(words: Word[]) {
  return words.filter((word) => !word.id.startsWith("sample-"));
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function shuffle<T>(items: T[]) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[randomIndex]] = [next[randomIndex], next[index]];
  }
  return next;
}

export function normalizeAnswer(value: string) {
  return value.toLowerCase().replace(/[\s.,!?，。！？]/g, "").trim();
}

export function isCorrectAnswer(input: string, answer: string) {
  const normalizedInput = normalizeAnswer(input);
  if (!normalizedInput) return false;
  return answer
    .split(/[,/;|]/)
    .map(normalizeAnswer)
    .some((candidate) => candidate === normalizedInput);
}

export function parseWords(text: string) {
  const words: Word[] = [];
  const invalidLines: string[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;

    // 반각 콜론(:), 전각 콜론(：), 등호(=), 대시(-), 탭(\t) 등 다양한 구분자 지원
    const match = line.match(/^(.+?)\s*[:：=\-\t]\s*(.+)$/);
    
    let term = "";
    let meaning = "";

    if (match) {
      term = match[1].trim();
      meaning = match[2].trim();
    } else {
      // 명확한 기호 구분자가 없는 경우 첫 번째 공백/스페이스를 기준으로 분리
      const spaceIndex = line.search(/\s/);
      if (spaceIndex > 0) {
        term = line.slice(0, spaceIndex).trim();
        meaning = line.slice(spaceIndex + 1).trim();
      }
    }

    const key = term.toLowerCase();

    if (!term || !meaning || seen.has(key)) {
      invalidLines.push(`${index + 1}번째 줄`);
      return;
    }

    seen.add(key);
    words.push({ id: makeId(), term, meaning });
  });

  return { words, invalidLines };
}