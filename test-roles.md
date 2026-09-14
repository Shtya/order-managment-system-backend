# Test writing roles and policies

Extracted from [Vitest: Testing in Practice](https://vitest.dev/guide/learn/testing-in-practice.html). Follow these rules when writing tests in this project.

---

## 1. What to test

- Test the **contract** of a function or module: what it promises to callers.
- The contract is defined by **inputs** (arguments, configuration) and **outputs** (return values, side effects, errors). Verify those, nothing else.
- Do **not** test private methods directly. See [section 16](#16-public-vs-private-methods).
- Do **not** assert internal options, intermediate variables, or which helper was called.
- **Policy:** if someone refactors internals but the output stays the same, the test must still pass. If it would fail, you are testing implementation details instead of behavior.

---

## 2. How to structure a test

Use **Arrange, Act, Assert**:

1. Set up the data the test needs.
2. Call the function or perform the action under test.
3. Check that the result matches expectations.

Comments labeling each section are optional. Keep each test focused on **one behavior**.

**Policy:** declare cases with `test()`, not `it()`. They are aliases in Vitest; this project standardizes on `test` so names and docs stay consistent.

---

## 3. One behavior per test

- Each test verifies one specific behavior.
- If the test name contains **"and"** (for example, "formats price and handles errors and logs the result"), split it into separate tests.

---

## 4. Descriptive names

- Name tests by **behavior**, not implementation.
- Good: `returns formatted price for USD`.
- Bad: `calls Intl.NumberFormat with correct options`.
- When a test fails, the name must tell you what broke without reading the test body.
- Avoid vague names: `works correctly`, `handles edge case`.
- Prefer specific names: `returns 0 for an empty cart`, `throws if the email format is invalid`, `preserves existing items when adding a new one`.
- Test output should read like a **specification** of what the module does.

---

## 5. Edge cases

After the happy path, cover:

- Boundaries (min, max, just-inside, just-outside).
- Unusual but valid inputs.
- Error paths (invalid input, missing resources, thrown errors).
- Input types a real caller might actually send.

**Policy:** do not test every possible input. Focus on boundaries, errors, and realistic callers.

**Policy:** if a real user or real caller could trigger an edge case, test it.

**Policy:** for numeric thresholds, test just inside, exactly at, and just outside the boundary.

---

## 6. Property-based testing (optional, advanced)

For functions with a wide range of valid inputs, describing **invariants** and generating many random inputs can find cases hand-picked tests miss.

- Example invariant: for any valid age string, `parseAge` returns a non-negative integer.
- Vitest works well with [fast-check](https://github.com/dubzzz/fast-check). Use this when manual edge cases are not enough.

---

## 7. When to mock

Mocking is allowed, but do not overuse it.

### Mock these

- **Slow dependencies:** network, filesystem, database — so tests stay milliseconds, not seconds.
- **HTTP:** prefer Mock Service Worker over mocking `fetch` directly. See [Mocking Requests](https://vitest.dev/guide/mocking/requests).
- **Non-deterministic values:** current date, random numbers, UUIDs. Use `vi.useFakeTimers()` and `vi.setSystemTime()` for time.

**Policy:** when a repository or query builder is mocked, assert the returned domain state, not the exact query shape. Prefer an in-memory fake over `toHaveBeenCalledWith({ where: { email: "ada@example.com" } })`. See [section 15](#15-observable-side-effects).

### Do not mock these

- **Do not mock the unit under test.** Testing `UserService` means `UserService` runs for real; mock its dependencies (DB, email, etc.).
- Prefer **real implementations** when they are fast and reliable (in-memory structures, pure functions).
- Closer to real usage means more confidence.

**Policy:** mock only when the real thing is slow, flaky, or has side effects you cannot control in a test.

---

## 8. Fixing bugs with tests

1. Write a **failing test** that reproduces the bug.
2. Confirm it fails.
3. Fix the production code.
4. Confirm the test passes.

Benefits: proves the bug is real, documents what broke, and prevents regression.

**Policy for AI agents:** reproduce with a failing test first, then fix the code. Do not "fix" a bug by changing the test instead of the code.

---

## 9. File layout

- One test file per source file is the default (`utils.ts` → `utils.spec.ts`).
- Colocated tests are fine. **Stay consistent** across the project.
- Vitest `include` matches both layouts by default.

---

## 10. Grouping with `describe`

- When a module exports multiple functions or methods, group tests with `describe` per function/method.
- That keeps output organized and shows which function a failing test belongs to.
- **Policy:** do not nest `describe` more than one or two levels. Deeper trees are hard to read and often mean the source module does too much.
- **Policy:** above each method `describe`, add a clickable reference to the implementation so Ctrl+click / F12 jumps to the source. Replace the class and method with the unit under test. Do not rely on the `describe` string for navigation.

```ts
void AuthService.prototype.login;

describe("login", () => {
```

---

## 11. Splitting large files

- If a test file grows beyond a few hundred lines, split by theme or feature.
- Example: `userService.test.ts` → `userService.creation.spec.ts` and `userService.auth.spec.ts`.
- Smaller files also make it faster to run a subset during development.

---

## 12. Test independence

- Create **fresh state in every test** (new list, new service instance, new fixtures). Tests must be able to run in any order.
- Repeated setup belongs in `beforeEach` or a `test.extend` fixture.
- If the module has **shared module-level state** (counters, caches, IDs), do not assert absolute values that depend on execution order. Assert relative properties (uniqueness, presence) instead.

---

## 13. What to cover for a typical module

Identify behaviors from the public API, then write tests for:

- Main purpose (happy path).
- Invalid input that should fail.
- Mutations that must not affect unrelated data.
- Missing IDs / not-found errors.
- Toggle / reverse operations.
- Empty vs populated query results.

Each `describe` = one method. Each `test` = one behavior. Do not use `it()`.

Public helpers (`sign`, `parseOAuthState`, and similar) get their own `describe` and are tested through their own contract. See [section 16](#16-public-vs-private-methods).

---

## 14. Normalize consistently

If a method accepts email, phone, or ID-like input:

- Normalize in **one** place in production code.
- Test that normalization at **every public entry point** that accepts the same input.
- Cover case, surrounding whitespace, and already-normalized values.

**Policy:** public methods that accept the same identifier must treat equivalent input the same way.

Example: `register`, `requestEmailChange`, and `isEmailExists` should all handle `" ADA@Example.COM "` the same way.

---

## 15. Observable side effects

When a method writes to a dependency (database, mailer, queue):

- Prefer a **fake that keeps state** over inspecting mock call arguments.
- Assert on that state after the call (saved record, queued message, and so on).
- Avoid `mock.calls[0][0]` unless the call itself is the public contract.

**Policy:** if someone changes how a dependency is invoked but the stored or sent result stays the same, the test must still pass.

---

## 16. Public vs private methods

- Every exported or public method gets its own `describe`.
- Do **not** add a `describe` for private methods (`isSuperAdmin` and similar).
- Test private logic through the public method that uses it.
- If the logic is important enough to test on its own, extract it to a public helper or utility.

**Policy:** if it is private, test it through a public method. If it needs a direct test, it should not stay private.

---

## Checklist

Before merging a test file, confirm:

- [ ] Tests assert contract (inputs/outputs/errors), not internals
- [ ] Arrange → Act → Assert
- [ ] Cases use `test()`, not `it()`
- [ ] One behavior per test; no "and" in names
- [ ] Names describe behavior and would be useful in CI
- [ ] Happy path plus realistic boundaries and error paths
- [ ] Mocks only for slow, flaky, or uncontrollable dependencies
- [ ] Unit under test is not mocked
- [ ] Bug fixes have a reproducing regression test
- [ ] Tests are independent (fresh setup; no order-dependent assertions)
- [ ] `describe` grouping is shallow and by public method/function
- [ ] Each method `describe` has a clickable `void ClassName.prototype.method` reference
- [ ] Identifier inputs (email, phone, IDs) are normalized and tested at every public entry point
- [ ] Side effects are asserted on fake state, not `mock.calls` unless the call is the contract
- [ ] Private methods are not tested directly
- [ ] Large files are split by feature when they exceed a few hundred lines
