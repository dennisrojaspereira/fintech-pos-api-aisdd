/**
 * Result<T, E> — discriminated union utilitária para retorno de domínio
 * sem exceções (ver design.md "Domain errors are returned as typed Result").
 *
 * Os agentes da W1+ devem usar este tipo em vez de criar variantes próprias.
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<E, T = never>(error: E): Result<T, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}
