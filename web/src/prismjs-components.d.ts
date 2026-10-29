declare module 'prismjs/components/prism-core.js' {
  export * from 'prismjs';
  export { default } from 'prismjs';
}

declare module 'prismjs/components/prism-*.js' {
  // Side-effect language components; no exports needed.
}
