import { initNativeHostListener } from './native-host';

/** Headless extension runtime used exclusively by the local Semantic Shell CLI. */
export default defineBackground(() => {
  initNativeHostListener();
});
