import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, existsSync } from "fs";
import path from "path";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8"));

const certPath = path.resolve(__dirname, "cert.pem");
const keyPath = path.resolve(__dirname, "key.pem");
const hasLocalCerts = existsSync(certPath) && existsSync(keyPath);

export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    ...(hasLocalCerts && {
      https: {
        cert: readFileSync(certPath),
        key: readFileSync(keyPath),
      },
    }),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    sourcemap: false,
  },
});
