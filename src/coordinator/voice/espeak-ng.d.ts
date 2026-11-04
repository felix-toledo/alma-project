// espeak-ng compiled to WASM (Emscripten): each instance runs the CLI once with `arguments`.
declare module 'espeak-ng' {
  interface EmscriptenFS {
    writeFile(path: string, data: Uint8Array): void
    readFile(path: string, options: { encoding: 'utf8' }): string
  }
  export default function ESpeakNg(options: { arguments: string[]; preRun?: ((module: { FS: EmscriptenFS }) => void)[] }): Promise<{ FS: EmscriptenFS }>
}
