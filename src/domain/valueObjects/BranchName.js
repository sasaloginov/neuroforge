const TRANSLIT = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

/**
 * Transliterate Russian characters to Latin.
 */
function transliterate(text) {
  return text
    .split('')
    .map(ch => {
      const lower = ch.toLowerCase();
      if (TRANSLIT[lower] !== undefined) {
        return ch === lower ? TRANSLIT[lower] : TRANSLIT[lower].toUpperCase();
      }
      return ch;
    })
    .join('');
}

/**
 * Convert a string to a URL/git-safe slug.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function slugify(text, maxLen = 50) {
  const slug = transliterate(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
  return slug;
}

/**
 * Generate a git branch name from a task shortId and title.
 * Format: NF-9/slug-of-title
 * @param {string} shortId — e.g. "NF-9"
 * @param {string} title — task title
 * @returns {string}
 */
function generateBranchName(shortId, title) {
  const slug = slugify(title);
  return `${shortId}/${slug}`;
}

export { transliterate, slugify, generateBranchName };
