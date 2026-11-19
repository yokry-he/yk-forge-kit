export interface BuildLogTextSanitizer { push: (content: string) => string; reset: () => void }
type State = 'text' | 'escape' | 'intermediate' | 'csi' | 'osc' | 'oscEscape' | 'string' | 'stringEscape';
/** Constant-memory incremental parser. Malformed sequences recover within 8192 code points. */
export function createBuildLogTextSanitizer(): BuildLogTextSanitizer {
  let state: State = 'text', length = 0;
  function reset() { state = 'text'; length = 0; }
  function push(content: string): string {
    let output = '';
    for (const char of content) {
      const code = char.codePointAt(0)!;
      if (state !== 'text' && ++length > 8192) reset();
      if (state === 'text') {
        if (char === '\x1b') { state = 'escape'; length = 0; }
        else if (char === '\x9b') { state = 'csi'; length = 0; }
        else if (char === '\x9d') { state = 'osc'; length = 0; }
        else if (code === 9 || code === 10 || (code >= 32 && !(code >= 127 && code <= 159))) output += char;
      } else if (state === 'escape') {
        if (char === '[') state = 'csi';
        else if (char === ']') state = 'osc';
        else if (['P', 'X', '^', '_'].includes(char)) state = 'string';
        else if (code >= 0x20 && code <= 0x2f) state = 'intermediate';
        else { reset(); if (!(code >= 0x30 && code <= 0x5f) && char !== 'c' && code >= 32) output += char; }
      } else if (state === 'intermediate') {
        if (code >= 0x30 && code <= 0x7e) reset();
      } else if (state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) reset();
        else if (char === '\x1b') state = 'escape';
        else if (!(code >= 0x20 && code <= 0x3f)) { reset(); if (code >= 160 || code === 10 || code === 9) output += char; }
      } else if (state === 'osc' || state === 'string') {
        if (char === '\x9c' || (state === 'osc' && char === '\x07')) reset();
        else if (char === '\x1b') state = state === 'osc' ? 'oscEscape' : 'stringEscape';
      } else {
        if (char === '\\' || char === '\x9c') reset();
        else if (char !== '\x1b') state = state === 'oscEscape' ? 'osc' : 'string';
      }
    }
    return output;
  }
  return { push, reset };
}
