// Vite inlines `?inline` imports as data URLs (the library's fonts).
declare module '*?inline' {
  const dataUrl: string
  export default dataUrl
}
