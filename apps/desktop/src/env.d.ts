/** Application version from package.json, injected at build time by Vite. */
declare const __APP_VERSION__: string;

/** Bundler-resolved URL of a worker module. */
declare module '*?worker&url' {
  const url: string;
  export default url;
}
