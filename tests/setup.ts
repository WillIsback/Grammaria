import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vite-plus/test";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

globalThis.fetch = vi.fn() as unknown as typeof fetch;
