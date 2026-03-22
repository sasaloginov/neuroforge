import { describe, it, expect } from 'vitest';
import { transliterate, slugify, generateBranchName } from './BranchName.js';

describe('BranchName', () => {
  describe('transliterate', () => {
    it('converts Russian to Latin', () => {
      expect(transliterate('привет')).toBe('privet');
    });

    it('leaves Latin characters unchanged', () => {
      expect(transliterate('hello')).toBe('hello');
    });

    it('handles mixed text', () => {
      expect(transliterate('Задача 123')).toBe('Zadacha 123');
    });

    it('handles ё, ж, щ, ъ, ь', () => {
      expect(transliterate('ёж')).toBe('yozh');
      expect(transliterate('щётка')).toBe('shchyotka');
      expect(transliterate('объём')).toBe('obyom');
    });
  });

  describe('slugify', () => {
    it('converts to lowercase slug', () => {
      expect(slugify('Hello World')).toBe('hello-world');
    });

    it('transliterates Russian', () => {
      expect(slugify('Добавить ревью')).toBe('dobavit-revyu');
    });

    it('removes special characters', () => {
      expect(slugify('feat: add API (v2)!')).toBe('feat-add-api-v2');
    });

    it('trims leading/trailing hyphens', () => {
      expect(slugify('---hello---')).toBe('hello');
    });

    it('truncates to maxLen', () => {
      const long = 'a'.repeat(100);
      expect(slugify(long, 50).length).toBeLessThanOrEqual(50);
    });

    it('does not end with hyphen after truncation', () => {
      const slug = slugify('hello world this is a very long title that exceeds', 20);
      expect(slug).not.toMatch(/-$/);
    });
  });

  describe('generateBranchName', () => {
    it('generates shortId/slug format', () => {
      expect(generateBranchName('NF-9', 'Add REST API')).toBe('NF-9/add-rest-api');
    });

    it('handles Russian titles', () => {
      expect(generateBranchName('NF-1', 'Добавить очередь задач')).toBe('NF-1/dobavit-ochered-zadach');
    });

    it('handles empty title gracefully', () => {
      expect(generateBranchName('NF-5', '')).toBe('NF-5/');
    });
  });
});
