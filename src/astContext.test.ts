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

  // --- New language paths ---

  it('parses Ruby def and class', () => {
    const content = `
class UserService
  def initialize(db)
    @db = db
  end

  def find_user(id)
    @db.find(id)
  end
end
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('user_service.rb', content);
    const names = parsed.elements.map((e) => e.name);
    expect(names).toContain('UserService');
    expect(names).toContain('initialize');
    expect(names).toContain('find_user');
  });

  it('parses Ruby module', () => {
    const content = `
module Authenticatable
  def authenticate(token)
    verify(token)
  end
end
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('auth.rb', content);
    const names = parsed.elements.map((e) => e.name);
    expect(names).toContain('Authenticatable');
    expect(names).toContain('authenticate');
  });

  it('parses Swift func and struct', () => {
    const content = `
public struct UserRepository {
  func fetchUser(id: String) -> User? {
    return store[id]
  }

  public func saveUser(_ user: User) {
    store[user.id] = user
  }
}

protocol Persistable {
  func save()
}
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('repo.swift', content);
    const names = parsed.elements.map((e) => e.name);
    expect(names).toContain('UserRepository');
    expect(names).toContain('fetchUser');
    expect(names).toContain('saveUser');
    expect(names).toContain('Persistable');
    const saveUser = parsed.elements.find((e) => e.name === 'saveUser');
    expect(saveUser?.exported).toBe(true);
  });

  it('parses Swift enum', () => {
    const content = `
enum Status {
  case active
  case inactive
}
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('status.swift', content);
    expect(parsed.elements.some((e) => e.name === 'Status' && e.type === 'enum')).toBe(true);
  });

  it('parses C# method and interface with modifiers', () => {
    const content = `
namespace MyApp.Services;

public interface IUserService {
  User GetUser(int id);
}

public class UserService : IUserService {
  public User GetUser(int id) {
    return _db.Find(id);
  }

  private void Validate(User user) {
    if (user == null) throw new ArgumentNullException();
  }
}
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('UserService.cs', content);
    const names = parsed.elements.map((e) => e.name);
    expect(names).toContain('IUserService');
    expect(names).toContain('UserService');
    expect(names).toContain('GetUser');
    expect(names).toContain('Validate');
    const getUser = parsed.elements.find((e) => e.name === 'GetUser');
    expect(getUser?.exported).toBe(true);
  });

  it('parses C struct and function', () => {
    const content = `
#include <stdio.h>

struct Point {
  int x;
  int y;
};

int add(int a, int b) {
  return a + b;
}

void print_point(struct Point p) {
  printf("%d %d\\n", p.x, p.y);
}
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('geometry.c', content);
    const names = parsed.elements.map((e) => e.name);
    expect(names).toContain('Point');
    expect(names).toContain('add');
    expect(names).toContain('print_point');
  });

  it('parses Bash function declarations', () => {
    const content = `
#!/usr/bin/env bash

setup_env() {
  export NODE_ENV=production
}

function run_tests {
  npm test
}
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('deploy.sh', content);
    const names = parsed.elements.map((e) => e.name);
    expect(names).toContain('setup_env');
    expect(names).toContain('run_tests');
  });

  it('parses Lua function declarations', () => {
    const content = `
function greet(name)
  print("Hello, " .. name)
end

local function helper()
  return 42
end
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('utils.lua', content);
    const names = parsed.elements.map((e) => e.name);
    expect(names).toContain('greet');
    expect(names).toContain('helper');
  });

  it('parses Scala def, class, object, trait', () => {
    const content = `
trait Repository[T] {
  def findById(id: Long): Option[T]
}

object UserRepository extends Repository[User] {
  def findById(id: Long): Option[User] = store.get(id)

  def save(user: User): Unit = {
    store(user.id) = user
  }
}

class UserService(repo: Repository[User]) {
  def getUser(id: Long) = repo.findById(id)
}
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('UserRepository.scala', content);
    const names = parsed.elements.map((e) => e.name);
    expect(names).toContain('UserRepository');
    expect(names).toContain('UserService');
    expect(names).toContain('findById');
    expect(names).toContain('save');
  });

  it('parses PHP function and class', () => {
    const content = `
<?php

class UserController {
  public function index(): void {
    echo "list";
  }

  private function validate(array $data): bool {
    return !empty($data);
  }
}

function bootstrap(): void {
  // setup
}
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('UserController.php', content);
    const names = parsed.elements.map((e) => e.name);
    expect(names).toContain('UserController');
    expect(names).toContain('index');
    expect(names).toContain('validate');
    expect(names).toContain('bootstrap');
  });

  it('detects exported flag on public C# methods', () => {
    const content = `
public class Foo {
  public void Bar() {}
  private void Baz() {}
}
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('Foo.cs', content);
    const bar = parsed.elements.find((e) => e.name === 'Bar');
    const baz = parsed.elements.find((e) => e.name === 'Baz');
    expect(bar?.exported).toBe(true);
    expect(baz?.exported).toBeFalsy();
  });

  it('detects class with modifier prefix (public class)', () => {
    const content = `
public class OrderService {}
abstract class BaseService {}
    `;
    const parsed = SimpleCodeAnalyzer.parseFileContent('OrderService.cs', content);
    const names = parsed.elements.map((e) => e.name);
    expect(names).toContain('OrderService');
    expect(names).toContain('BaseService');
    const order = parsed.elements.find((e) => e.name === 'OrderService');
    expect(order?.exported).toBe(true);
  });
});
