import type { LanguagePreset, SupportedLanguage } from '../types'

export const languagePresets: Record<SupportedLanguage, LanguagePreset> = {
  javascript: {
    title: 'JavaScript: Event Loop, Closure Reads, Memory',
    code: `let base = 4;
let audit = 0;

function multiply(n) {
  let result = n * 3;
  return result;
}

function capture(value) {
  audit = value + 1;
  return audit;
}

let score = multiply(base);
Promise.resolve().then(() => capture(score));
setTimeout(() => capture(score + 10), 0);
let numbers = [1, 2, score];
let profile = { name: "Ada", total: score };
score = score + 5;
queueMicrotask(() => capture(score + 2));
console.log(score);`,
  },
  typescript: {
    title: 'TypeScript: Event Loop with Typed State',
    code: `let count: number = 2;
let total: number = 0;

function square(value: number): number {
  let out: number = value * value;
  return out;
}

function publish(value: number): number {
  total = value + 3;
  return total;
}

let area: number = square(count);
Promise.resolve().then(() => publish(area));
setTimeout(() => publish(area + 10), 0);
let items: number[] = [count, area, 9];
let user: { id: number; label: string } = { id: 10, label: "TS" };
area = area + 1;
queueMicrotask(() => publish(area + 1));
console.log(total);`,
  },
  c: {
    title: 'C: Stack, Heap-Like References, Pointer',
    code: `#include <stdio.h>

int add(int a, int b) {
  int sum = a + b;
  return sum;
}

int main() {
  int value = 5;
  int total = add(value, 3);
  int arr[3] = {1, 2, total};
  int *ptr = &value;
  *ptr = 9;
  return 0;
}`,
  },
  cpp: {
    title: 'C++: Function, Struct-Like Object, Pointer',
    code: `#include <iostream>

int makeValue(int a) {
  int next = a + 2;
  return next;
}

int main() {
  int first = 7;
  int second = makeValue(first);
  int nums[3] = {first, second, 20};
  int *link = &second;
  *link = 99;
  return 0;
}`,
  },
}
