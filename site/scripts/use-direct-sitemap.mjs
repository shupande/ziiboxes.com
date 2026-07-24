import { copyFile } from "node:fs/promises";

await copyFile("dist/sitemap-0.xml", "dist/sitemap.xml");
