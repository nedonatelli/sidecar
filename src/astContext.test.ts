import { describe, it, expect } from 'vitest';
import { SimpleCodeAnalyzer } from './astContext.js';

describe('SimpleCodeAnalyzer', () => {
  it('parses functions correctly', () => {
    const content = `
function hello() {
  console.log('hello');
}

function goodbye() {
  console.log('goodbye');
}
    `;

    const parsed = SimpleCodeAnalyzer.parseFileContent('test.js', content);
    expect(parsed.elements.length).toBe(2);
    expect(parsed.elements[0].type).toBe('function');
    expect(parsed.elements[0].name).toBe('hello');
  });

  it('parses classes correctly', () => {
    const content = `
class MyClass {
  constructor() {}
  
  myMethod() {
    return 'hello';
  }
}
    `;

    const parsed = SimpleCodeAnalyzer.parseFileContent('test.js', content);
    expect(parsed.elements.length).toBe(1);
    expect(parsed.elements[0].type).toBe('class');
    expect(parsed.elements[0].name).toBe('MyClass');
  });

  it('finds relevant elements based on query', () => {
    const content = `
function processUser(userId) {
  return users[userId];
}

function saveUser(user) {
  return database.save(user);
}
    `;

    const parsed = SimpleCodeAnalyzer.parseFileContent('test.js', content);
    const relevant = SimpleCodeAnalyzer.findRelevantElements(parsed, 'process');

    expect(relevant.length).toBe(1);
    expect(relevant[0].name).toBe('processUser');
  });

  it('extracts relevant content correctly', () => {
    const content = `
function hello() {
  console.log('hello');
}

function goodbye() {
  console.log('goodbye');
}
    `;

    const parsed = SimpleCodeAnalyzer.parseFileContent('test.js', content);
    const relevant = SimpleCodeAnalyzer.findRelevantElements(parsed, 'hello');

    const extracted = SimpleCodeAnalyzer.extractRelevantContent(parsed, relevant);
    expect(extracted).toContain('hello');
    expect(extracted).toContain('console.log');
  });
});
