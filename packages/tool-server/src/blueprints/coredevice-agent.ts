import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createInterface, type Interface } from "node:readline";

/**
 * The persistent CoreDevice agent (a small pymobiledevice3 program) that a
 * physical iPhone is driven through. It is base64-embedded rather than shipped
 * as a loose `.py` so it survives esbuild bundling with zero build-pipeline
 * wiring, and base64 (not a template literal) so its Python `\s`/`\n` escapes
 * can't be mangled by JS string parsing.
 *
 * Source of truth: `coredevice-agent.py` sits next to this file; after editing
 * it, regenerate this constant with `base64 -i coredevice-agent.py | tr -d '\n'`.
 * A test asserts the two stay in sync. The decoded script speaks
 * newline-delimited JSON on stdio (see AGENT_PROTOCOL below).
 */
const AGENT_SCRIPT_B64 =
  "IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJQZXJzaXN0ZW50IENvcmVEZXZpY2UgYWdlbnQg4oCUIG9uZSBsb25nLWxpdmVkIHByb2Nlc3MgcGVyIHBoeXNpY2FsIGlQaG9uZS4KClJlcGxhY2VzIHBlci1jYWxsIGBweW1vYmlsZWRldmljZTNgIENMSSBzcGF3bnMgKGVhY2ggfjAuOHMsIH4wLjVzIGp1c3QgdGhlClB5dGhvbiBpbXBvcnQpIHdpdGggYSBzaW5nbGUgcHJvY2VzcyB0aGF0IGNvbm5lY3RzIHRoZSBSU0QgdHVubmVsIG9uY2UsIGhvbGRzCnRoZSB0b3VjaHNjcmVlbiBtZWRpYS1zdHJlYW0gc2Vzc2lvbiArIHNjcmVlbnNob3Qgc2VydmljZSBvcGVuLCBhbmQgZXhlY3V0ZXMKbmV3bGluZS1kZWxpbWl0ZWQgSlNPTiBjb21tYW5kcyBvbiBzdGRpbiwgcmVwbHlpbmcgd2l0aCBvbmUgSlNPTiBsaW5lIGVhY2guCgpSZXVzZXMgcHltb2JpbGVkZXZpY2UzJ3Mgb3duIENMSSBoZWxwZXJzIHNvIGJlaGF2aW91ciBpcyBpZGVudGljYWwgdG8gdGhlCmBkZXZlbG9wZXIgY29yZS1kZXZpY2Ug4oCmYCBjb21tYW5kcyAoZHdlbGwtZHJhZyB0YXAsIG1haW5Ub3VjaHNjcmVlbiByZXBvcnRzLApJbmRpZ28gaGFyZHdhcmUgYnV0dG9ucywgc2NyZWVuLWNhcHR1cmUgUE5HKS4KClByb3RvY29sIChvbmUgSlNPTiBvYmplY3QgcGVyIGxpbmUpOgogIDwtIHsidWRpZCI6ICIuLi4iLCAicG9ydCI6IDQ5MTUxfSAgICAgICAgICAgICAgICAgKGFyZ3YsIG5vdCBzdGRpbikKICAtPiB7InJlYWR5IjogdHJ1ZX0gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAob3IgeyJyZWFkeSI6IGZhbHNlLCAiZXJyb3IiOiAiLi4uIn0pCiAgPC0geyJpZCI6IDEsICJvcCI6ICJzY3JlZW5zaG90In0KICAtPiB7ImlkIjogMSwgIm9rIjogdHJ1ZSwgImltYWdlX2I2NCI6ICIuLi4ifQogIDwtIHsiaWQiOiAyLCAib3AiOiAidGFwIiwgIngiOiAzMjc2OCwgInkiOiAyMDAwMH0gICAgICAgICAgKHgveSBhbHJlYWR5IDAuLjY1NTM1KQogIDwtIHsiaWQiOiAzLCAib3AiOiAic3dpcGUiLCAieDEiOi4uLCAieTEiOi4uLCAieDIiOi4uLCAieTIiOi4uLCAic3RlcHMiOjE5LCAiZHVyYXRpb24iOjAuM30KICA8LSB7ImlkIjogNCwgIm9wIjogImJ1dHRvbiIsICJuYW1lIjogImhvbWUifQogIDwtIHsiaWQiOiA1LCAib3AiOiAiaG9tZXNjcmVlbiJ9ICAgICAgICAgICAgICAgICAgICAgICAgICAgIChzcHJpbmdib2FyZCBpY29uIGdyaWQpCiAgLT4geyJpZCI6IE4sICJvayI6IHRydWUsIC4uLn0gIHwgIHsiaWQiOiBOLCAiZXJyb3IiOiAiLi4uIiwgImdhdGVkXzkwMjEiOiBib29sfQoiIiIKaW1wb3J0IGFzeW5jaW8KaW1wb3J0IGJhc2U2NAppbXBvcnQgY29udGV4dGxpYgppbXBvcnQganNvbgppbXBvcnQgc3lzCgpmcm9tIHB5bW9iaWxlZGV2aWNlMy5yZW1vdGUucmVtb3RlX3NlcnZpY2VfZGlzY292ZXJ5IGltcG9ydCBSZW1vdGVTZXJ2aWNlRGlzY292ZXJ5U2VydmljZQpmcm9tIHB5bW9iaWxlZGV2aWNlMy5yZW1vdGUuY29yZV9kZXZpY2UuaGlkX3NlcnZpY2UgaW1wb3J0ICgKICAgIHRvdWNoX3Nlc3Npb24sCiAgICBJbmRpZ29ISURTZXJ2aWNlLAogICAgRElHSVRJWkVSX1NVUkZBQ0VfTUFJTl9UT1VDSFNDUkVFTiwKKQpmcm9tIHB5bW9iaWxlZGV2aWNlMy5yZW1vdGUuY29yZV9kZXZpY2Uuc2NyZWVuX2NhcHR1cmVfc2VydmljZSBpbXBvcnQgU2NyZWVuQ2FwdHVyZVNlcnZpY2UKZnJvbSBweW1vYmlsZWRldmljZTMuc2VydmljZXMuc3ByaW5nYm9hcmQgaW1wb3J0IFNwcmluZ0JvYXJkU2VydmljZXNTZXJ2aWNlCmZyb20gcHltb2JpbGVkZXZpY2UzLmNsaS5kZXZlbG9wZXIuY29yZV9kZXZpY2UgaW1wb3J0IF9kb19kcmFnLCBfc2VuZF9idXR0b25fcHJlc3MsIF9OQU1FRF9CVVRUT05TCmZyb20gcHltb2JpbGVkZXZpY2UzLmR0eF9zZXJ2aWNlX3Byb3ZpZGVyIGltcG9ydCBEdHhTZXJ2aWNlUHJvdmlkZXIKZnJvbSBweW1vYmlsZWRldmljZTMuZHR4LmNvbm5lY3Rpb24gaW1wb3J0IERUWENvbm5lY3Rpb24KZnJvbSBweW1vYmlsZWRldmljZTMuc2VydmljZXMuYWNjZXNzaWJpbGl0eWF1ZGl0IGltcG9ydCBBY2Nlc3NpYmlsaXR5QXVkaXQsIGRlc2VyaWFsaXplX29iamVjdAoKaW1wb3J0IHVybGxpYi5yZXF1ZXN0CgoKIyAtLS0gUlNEQ2hlY2tpbiBmaXggZm9yIHRoZSBpT1MtMjYrIGFjY2Vzc2liaWxpdHkgKGF4QXVkaXQpIERUWCBzZXJ2aWNlIC0tLS0tLS0tCiMgSW4gaU9TIDI2IEFwcGxlIHJlLXBsdW1iZWQgYXhhdWRpdGQgb250byBSZW1vdGVTZXJ2aWNlRGlzY292ZXJ5OyB0aGUKIyBg4oCmYXhBdWRpdERhZW1vbi5yZW1vdGVzZXJ2ZXIuc2hpbS5yZW1vdGVgIERUWCBkYWVtb24gbm93IHJlcXVpcmVzIHRoZSBSU0RDaGVja2luCiMgaGFuZHNoYWtlIGJlZm9yZSBpdCBhY2NlcHRzIERUWCBmcmFtaW5nLiBweW1vYmlsZWRldmljZTMncyBEdHhTZXJ2aWNlUHJvdmlkZXIKIyBvcGVucyBSU0Qgc2VydmljZXMgd2l0aCBhIHJhdyBjb25uZWN0IChjcmVhdGVfc2VydmljZV9jb25uZWN0aW9uKSBhbmQgc2tpcHMKIyBSU0RDaGVja2luLCBzbyBpT1MgMjYvMjcgZHJvcHMgdGhlIGNvbm5lY3Rpb24gb24gdGhlIGZpcnN0IGJ5dGUuIHN0YXJ0X2xvY2tkb3duX3NlcnZpY2UKIyBwZXJmb3JtcyBSU0RDaGVja2luIOKAlCByb3V0ZSBSU0QgRFRYIG9wZW5zIHRocm91Z2ggaXQuIChyZWY6IGxpdHRsZWRpdnkvaXBob25lLW1pcnJvcmluZy1heGR1bXApCl9vcmlnX29wZW5fZHR4ID0gRHR4U2VydmljZVByb3ZpZGVyLl9vcGVuX2R0eF9jb25uZWN0aW9uCgoKYXN5bmMgZGVmIF9vcGVuX2R0eF93aXRoX2NoZWNraW4oc2VsZiwgc2VydmljZV9uYW1lLCAqLCBzdHJpcF9zc2w9RmFsc2UpOgogICAgaWYgaXNpbnN0YW5jZShzZWxmLmxvY2tkb3duLCBSZW1vdGVTZXJ2aWNlRGlzY292ZXJ5U2VydmljZSk6CiAgICAgICAgc3ZjID0gYXdhaXQgc2VsZi5sb2NrZG93bi5zdGFydF9sb2NrZG93bl9zZXJ2aWNlKHNlcnZpY2VfbmFtZSkKICAgICAgICByZXR1cm4gRFRYQ29ubmVjdGlvbihzdmMucmVhZGVyLCBzdmMud3JpdGVyKQogICAgcmV0dXJuIGF3YWl0IF9vcmlnX29wZW5fZHR4KHNlbGYsIHNlcnZpY2VfbmFtZSwgc3RyaXBfc3NsPXN0cmlwX3NzbCkKCgpEdHhTZXJ2aWNlUHJvdmlkZXIuX29wZW5fZHR4X2Nvbm5lY3Rpb24gPSBfb3Blbl9kdHhfd2l0aF9jaGVja2luCgoKZGVmIF9yZXNvbHZlX3JzZCh1ZGlkOiBzdHIsIHBvcnQ6IGludCk6CiAgICBwYXlsb2FkID0ganNvbi5sb2FkKHVybGxpYi5yZXF1ZXN0LnVybG9wZW4oZiJodHRwOi8vMTI3LjAuMC4xOntwb3J0fS8iLCB0aW1lb3V0PTQpKQogICAgZW50cnkgPSBwYXlsb2FkLmdldCh1ZGlkKSBvciBbXQogICAgdCA9IGVudHJ5WzBdIGlmIGVudHJ5IGVsc2Uge30KICAgIGFkZHIsIHRwb3J0ID0gdC5nZXQoInR1bm5lbC1hZGRyZXNzIiksIHQuZ2V0KCJ0dW5uZWwtcG9ydCIpCiAgICBpZiBub3QgYWRkciBvciBub3QgdHBvcnQ6CiAgICAgICAgcmFpc2UgUnVudGltZUVycm9yKGYibm8gYWN0aXZlIHR1bm5lbCByZWdpc3RlcmVkIGZvciB7dWRpZH0gb24gdHVubmVsZCA6e3BvcnR9IikKICAgIHJldHVybiBhZGRyLCBpbnQodHBvcnQpCgoKYXN5bmMgZGVmIF9tYXliZV9hd2FpdCh2KToKICAgIHJldHVybiBhd2FpdCB2IGlmIGFzeW5jaW8uaXNjb3JvdXRpbmUodikgZWxzZSB2CgoKY2xhc3MgQWdlbnQ6CiAgICBkZWYgX19pbml0X18oc2VsZiwgdWRpZDogc3RyLCBwb3J0OiBpbnQpOgogICAgICAgIHNlbGYudWRpZCA9IHVkaWQKICAgICAgICBzZWxmLnBvcnQgPSBwb3J0CiAgICAgICAgc2VsZi5yc2QgPSBOb25lCiAgICAgICAgc2VsZi5zdGFjayA9IGNvbnRleHRsaWIuQXN5bmNFeGl0U3RhY2soKQogICAgICAgIHNlbGYudG91Y2ggPSBOb25lICAjIFVuaXZlcnNhbEhJRFNlcnZpY2VTZXJ2aWNlLCBoZWxkIG9wZW4gKG1lZGlhIHN0cmVhbSBzdGF5cyB3YXJtKQoKICAgIGFzeW5jIGRlZiBjb25uZWN0KHNlbGYpOgogICAgICAgIGFkZHIsIHRwb3J0ID0gX3Jlc29sdmVfcnNkKHNlbGYudWRpZCwgc2VsZi5wb3J0KQogICAgICAgIHNlbGYucnNkID0gUmVtb3RlU2VydmljZURpc2NvdmVyeVNlcnZpY2UoKGFkZHIsIHRwb3J0KSkKICAgICAgICBhd2FpdCBzZWxmLnJzZC5jb25uZWN0KCkKCiAgICBhc3luYyBkZWYgX2Vuc3VyZV90b3VjaChzZWxmKToKICAgICAgICAjIExhemlseSBvcGVuIChhbmQga2VlcCkgdGhlIHRvdWNoc2NyZWVuIG1lZGlhLXN0cmVhbSBzZXNzaW9uIOKAlCB0aGUgYXV0aAogICAgICAgICMgZ2F0ZSBiYWNrYm9hcmRkIG5lZWRzIGZvciBpbmplY3RlZCB0b3VjaGVzLiBLZXB0IHdhcm0gc28gdGFwcyBkb24ndCBwYXkKICAgICAgICAjIHRoZSBtZWRpYS1zdHJlYW0gc3RhcnR1cCBlYWNoIHRpbWUuCiAgICAgICAgaWYgc2VsZi50b3VjaCBpcyBOb25lOgogICAgICAgICAgICBzZWxmLnRvdWNoID0gYXdhaXQgc2VsZi5zdGFjay5lbnRlcl9hc3luY19jb250ZXh0KHRvdWNoX3Nlc3Npb24oc2VsZi5yc2QpKQogICAgICAgIHJldHVybiBzZWxmLnRvdWNoCgogICAgYXN5bmMgZGVmIG9wX3NjcmVlbnNob3Qoc2VsZiwgXyk6CiAgICAgICAgIyBTY3JlZW5DYXB0dXJlU2VydmljZSBkZWxpdmVycyBvbmUgUE5HIHBlciBvcGVuICh0aGUgc3RyZWFtIGVuZHMgYWZ0ZXIKICAgICAgICAjIHRoZSBmcmFtZSksIHNvIG9wZW4gYSBmcmVzaCBvbmUgZWFjaCBjYWxsIOKAlCBjaGVhcCBub3cgdGhlIGludGVycHJldGVyCiAgICAgICAgIyBhbmQgdHVubmVsIGFyZSBhbHJlYWR5IHdhcm0uCiAgICAgICAgYXN5bmMgd2l0aCBTY3JlZW5DYXB0dXJlU2VydmljZShzZWxmLnJzZCkgYXMgc2NyZWVuOgogICAgICAgICAgICByZXNwID0gYXdhaXQgc2NyZWVuLmNhcHR1cmVfc2NyZWVuc2hvdCgpCiAgICAgICAgcmV0dXJuIHsiaW1hZ2VfYjY0IjogYmFzZTY0LmI2NGVuY29kZShyZXNwWyJpbWFnZSJdKS5kZWNvZGUoImFzY2lpIil9CgogICAgYXN5bmMgZGVmIG9wX3RhcChzZWxmLCBtc2cpOgogICAgICAgIHN2YyA9IGF3YWl0IHNlbGYuX2Vuc3VyZV90b3VjaCgpCiAgICAgICAgeCwgeSA9IGludChtc2dbIngiXSksIGludChtc2dbInkiXSkKICAgICAgICAjIFplcm8tZHdlbGwgdGFwcyBhcmUgZHJvcHBlZCBieSBpT1M7IGVtaXQgYSBzaG9ydCBoZWxkIGRyYWcgd2l0aCBhIHRpbnkKICAgICAgICAjIG1vdmUgYXdheSBmcm9tIHRoZSBlZGdlIChtaXJyb3JzIGNvcmUtZGV2aWNlLnRzIC8gdGhlIENMSSBkcmFnIHBhdGgpLgogICAgICAgIHkyID0geSArIDk2IGlmIHkgPD0gNjU1MzUgLSAxMjAgZWxzZSB5IC0gOTYKICAgICAgICBhd2FpdCBfZG9fZHJhZyhzdmMsIHgsIHksIHgsIHkyLCAzLCAwLjE1LCB0c2lkPURJR0lUSVpFUl9TVVJGQUNFX01BSU5fVE9VQ0hTQ1JFRU4pCiAgICAgICAgcmV0dXJuIHt9CgogICAgYXN5bmMgZGVmIG9wX3N3aXBlKHNlbGYsIG1zZyk6CiAgICAgICAgc3ZjID0gYXdhaXQgc2VsZi5fZW5zdXJlX3RvdWNoKCkKICAgICAgICBhd2FpdCBfZG9fZHJhZygKICAgICAgICAgICAgc3ZjLCBpbnQobXNnWyJ4MSJdKSwgaW50KG1zZ1sieTEiXSksIGludChtc2dbIngyIl0pLCBpbnQobXNnWyJ5MiJdKSwKICAgICAgICAgICAgaW50KG1zZy5nZXQoInN0ZXBzIiwgMTkpKSwgZmxvYXQobXNnLmdldCgiZHVyYXRpb24iLCAwLjMpKSwKICAgICAgICAgICAgdHNpZD1ESUdJVElaRVJfU1VSRkFDRV9NQUlOX1RPVUNIU0NSRUVOLAogICAgICAgICkKICAgICAgICByZXR1cm4ge30KCiAgICBhc3luYyBkZWYgb3BfYnV0dG9uKHNlbGYsIG1zZyk6CiAgICAgICAgbmFtZSA9IG1zZ1sibmFtZSJdCiAgICAgICAgaWYgbmFtZSBub3QgaW4gX05BTUVEX0JVVFRPTlM6CiAgICAgICAgICAgIHJhaXNlIFJ1bnRpbWVFcnJvcihmInVua25vd24gYnV0dG9uICd7bmFtZX0nIikKICAgICAgICB1c2FnZV9wYWdlLCB1c2FnZV9jb2RlLCBob2xkID0gX05BTUVEX0JVVFRPTlNbbmFtZV0KICAgICAgICBhc3luYyB3aXRoIEluZGlnb0hJRFNlcnZpY2Uoc2VsZi5yc2QpIGFzIHN2YzoKICAgICAgICAgICAgYXdhaXQgX3NlbmRfYnV0dG9uX3ByZXNzKHN2YywgdXNhZ2VfcGFnZSwgdXNhZ2VfY29kZSwgInByZXNzIiwgaG9sZCkKICAgICAgICByZXR1cm4ge30KCiAgICBhc3luYyBkZWYgb3BfaG9tZXNjcmVlbihzZWxmLCBfKToKICAgICAgICBzYiA9IFNwcmluZ0JvYXJkU2VydmljZXNTZXJ2aWNlKGxvY2tkb3duPXNlbGYucnNkKQogICAgICAgIGljb25zID0gYXdhaXQgX21heWJlX2F3YWl0KHNiLmdldF9pY29uX3N0YXRlKCkpCiAgICAgICAgbWV0cmljcyA9IGF3YWl0IF9tYXliZV9hd2FpdChzYi5nZXRfaG9tZXNjcmVlbl9pY29uX21ldHJpY3MoKSkKICAgICAgICByZXR1cm4geyJpY29uX3N0YXRlIjogaWNvbnMsICJtZXRyaWNzIjogbWV0cmljc30KCiAgICBhc3luYyBkZWYgb3BfYXh0cmVlKHNlbGYsIG1zZyk6CiAgICAgICAgIiIiVGhlIG9uLXNjcmVlbiBhY2Nlc3NpYmlsaXR5IHRyZWUgb2Ygd2hhdGV2ZXIgYXBwIGlzIGZyb250bW9zdCAob3IgdGhlCiAgICAgICAgaG9tZSBzY3JlZW4pLCB2aWEgdGhlIGlPUy0yNisgYXhBdWRpdCBzZXJ2aWNlIChSU0RDaGVja2luLXVubG9ja2VkIGFib3ZlKS4KCiAgICAgICAgUmV0dXJucyBlYWNoIGVsZW1lbnQncyBhY2Nlc3NpYmxlIGNhcHRpb24gKGxhYmVsICsgdmFsdWUgKyB0cmFpdHMpIGluCiAgICAgICAgVm9pY2VPdmVyIHJlYWRpbmcgb3JkZXIgcGx1cyBhIHN0YWJsZSBlbGVtZW50IGlkLCBhbmQg4oCUIHdoZXJlIHRoZQogICAgICAgIGFjY2Vzc2liaWxpdHkgYXVkaXQgcmVwb3J0cyBvbmUg4oCUIGl0cyBvbi1zY3JlZW4gcmVjdCBpbiBwb2ludHMuIFBlci1lbGVtZW50CiAgICAgICAgZ2VvbWV0cnkgaXNuJ3QgZXhwb3NlZCBvbiBoYXJkd2FyZSwgc28gb25seSBhdWRpdGVkIGVsZW1lbnRzIGNhcnJ5IGEgcmVjdDsKICAgICAgICB0aGUgVFMgbGF5ZXIgZmlsbHMgdGhlIGdhcHMuIFNjcmVlbiBzaXplIChwb2ludHMpIGNvbWVzIGZyb20gU3ByaW5nQm9hcmQuCiAgICAgICAgIiIiCiAgICAgICAgbGltaXQgPSBpbnQobXNnLmdldCgibGltaXQiLCAxMjApKQoKICAgICAgICAjIDEpIFdhbGsgdGhlIGVsZW1lbnRzIChjYXB0aW9uICsgcmVhZGluZyBvcmRlciArIGVsZW1lbnQgaWQpLgogICAgICAgIHdhbGsgPSBBY2Nlc3NpYmlsaXR5QXVkaXQoc2VsZi5yc2QpCiAgICAgICAgZWxlbWVudHMgPSBbXQogICAgICAgIHRyeToKICAgICAgICAgICAgYXN5bmMgZm9yIGVsIGluIHdhbGsuaXRlcl9lbGVtZW50cygpOgogICAgICAgICAgICAgICAgZWxlbWVudHMuYXBwZW5kKAogICAgICAgICAgICAgICAgICAgIHsiY2FwdGlvbiI6IGVsLmNhcHRpb24sICJpZCI6IGVsLmVsZW1lbnQuaWRlbnRpZmllci5oZXgoKX0KICAgICAgICAgICAgICAgICkKICAgICAgICAgICAgICAgIGlmIGxlbihlbGVtZW50cykgPj0gbGltaXQ6CiAgICAgICAgICAgICAgICAgICAgYnJlYWsKICAgICAgICBmaW5hbGx5OgogICAgICAgICAgICB3aXRoIGNvbnRleHRsaWIuc3VwcHJlc3MoRXhjZXB0aW9uKToKICAgICAgICAgICAgICAgIGF3YWl0IHdhbGsuY2xvc2UoKQoKICAgICAgICAjIDIpIEF1ZGl0IGZvciByZWN0cywga2V5ZWQgYnkgZWxlbWVudCBpZCAodGhlIG9ubHkgaGFyZHdhcmUgZnJhbWUgc291cmNlKS4KICAgICAgICByZWN0cyA9IHt9CiAgICAgICAgYXVkaXQgPSBBY2Nlc3NpYmlsaXR5QXVkaXQoc2VsZi5yc2QpCiAgICAgICAgdHJ5OgogICAgICAgICAgICB0eXBlcyA9IGF3YWl0IGF1ZGl0LnN1cHBvcnRlZF9hdWRpdHNfdHlwZXMoKQogICAgICAgICAgICBhd2FpdCBhdWRpdC5fZW5zdXJlX3JlYWR5KCkKICAgICAgICAgICAgYXdhaXQgYXVkaXQuX2ludm9rZSgiZGV2aWNlQmVnaW5BdWRpdFR5cGVzOiIsIHR5cGVzLCBleHBlY3RzX3JlcGx5PUZhbHNlKQogICAgICAgICAgICBkZWFkbGluZSA9IGFzeW5jaW8uZ2V0X2V2ZW50X2xvb3AoKS50aW1lKCkgKyAxMC4wCiAgICAgICAgICAgIHdoaWxlIFRydWU6CiAgICAgICAgICAgICAgICAjIEJvdW5kZWQgd2FpdDogaWYgdGhlIGNvbXBsZXRpb24gZXZlbnQgbmV2ZXIgYXJyaXZlcyAobG9ja2VkCiAgICAgICAgICAgICAgICAjIGRldmljZSwgdW5zdXBwb3J0ZWQgYXVkaXQpLCBhbiB1bmJvdW5kZWQgZ2V0KCkgd291bGQgd2VkZ2UKICAgICAgICAgICAgICAgICMgdGhpcyBzdHJpY3RseS1zZXJpYWwgYWdlbnQgZm9yZXZlciDigJQgZXZlcnkgbGF0ZXIgb3AgdGhlbgogICAgICAgICAgICAgICAgIyB0aW1lcyBvdXQgY2xpZW50LXNpZGUuIFRpbWVvdXQgZmFsbHMgaW50byB0aGUgYmVzdC1lZmZvcnQKICAgICAgICAgICAgICAgICMgZXhjZXB0IGJlbG93IGFuZCB0aGUgdHJlZSBzdGlsbCByZXR1cm5zIHdpdGhvdXQgcmVjdHMuCiAgICAgICAgICAgICAgICByZW1haW5pbmcgPSBkZWFkbGluZSAtIGFzeW5jaW8uZ2V0X2V2ZW50X2xvb3AoKS50aW1lKCkKICAgICAgICAgICAgICAgIGlmIHJlbWFpbmluZyA8PSAwOgogICAgICAgICAgICAgICAgICAgIHJhaXNlIFRpbWVvdXRFcnJvcigiYXVkaXQgY29tcGxldGlvbiBldmVudCBub3QgcmVjZWl2ZWQgd2l0aGluIDEwcyIpCiAgICAgICAgICAgICAgICBuYW1lLCBhcmdzID0gYXdhaXQgYXN5bmNpby53YWl0X2ZvcihhdWRpdC5fZXZlbnRfcXVldWUuZ2V0KCksIHRpbWVvdXQ9cmVtYWluaW5nKQogICAgICAgICAgICAgICAgaWYgbmFtZSAhPSAiaG9zdERldmljZURpZENvbXBsZXRlQXVkaXRDYXRlZ29yaWVzV2l0aEF1ZGl0SXNzdWVzOiI6CiAgICAgICAgICAgICAgICAgICAgY29udGludWUKICAgICAgICAgICAgICAgIGlzc3VlcyA9IGRlc2VyaWFsaXplX29iamVjdChhdWRpdC5fZXh0cmFjdF9ldmVudF9wYXlsb2FkKGFyZ3MpKQogICAgICAgICAgICAgICAgIyBpT1MgMjcgcmV0dXJucyB0aGUgQVhBdWRpdElzc3VlIGxpc3QgZGlyZWN0bHk7IG9sZGVyIHdyYXAgaXQgaW4gW3sidmFsdWUiOuKApn1dLgogICAgICAgICAgICAgICAgaWYgKAogICAgICAgICAgICAgICAgICAgIGlzaW5zdGFuY2UoaXNzdWVzLCBsaXN0KQogICAgICAgICAgICAgICAgICAgIGFuZCBpc3N1ZXMKICAgICAgICAgICAgICAgICAgICBhbmQgaXNpbnN0YW5jZShpc3N1ZXNbMF0sIGRpY3QpCiAgICAgICAgICAgICAgICAgICAgYW5kICJ2YWx1ZSIgaW4gaXNzdWVzWzBdCiAgICAgICAgICAgICAgICApOgogICAgICAgICAgICAgICAgICAgIGlzc3VlcyA9IGlzc3Vlc1swXVsidmFsdWUiXQogICAgICAgICAgICAgICAgZm9yIGlzcyBpbiBpc3N1ZXMgb3IgW106CiAgICAgICAgICAgICAgICAgICAgdHJ5OgogICAgICAgICAgICAgICAgICAgICAgICBlaWQgPSBpc3MuX2ZpZWxkc1siQXVkaXRFbGVtZW50VmFsdWVfdjEiXS5fZmllbGRzWwogICAgICAgICAgICAgICAgICAgICAgICAgICAgIlBsYXRmb3JtRWxlbWVudFZhbHVlX3YxIgogICAgICAgICAgICAgICAgICAgICAgICBdLmhleCgpCiAgICAgICAgICAgICAgICAgICAgICAgIHJlY3QgPSBpc3MuX2ZpZWxkcy5nZXQoIkVsZW1lbnRSZWN0VmFsdWVfdjEiKQogICAgICAgICAgICAgICAgICAgICAgICBpZiBlaWQgYW5kIHJlY3QgYW5kIGVpZCBub3QgaW4gcmVjdHM6CiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWN0c1tlaWRdID0gcmVjdAogICAgICAgICAgICAgICAgICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgICAgICAgICBicmVhawogICAgICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgICAgIHBhc3MgICMgYXVkaXQgaXMgYmVzdC1lZmZvcnQ7IHRoZSB0cmVlIHN0aWxsIHJldHVybnMgd2l0aG91dCByZWN0cwogICAgICAgIGZpbmFsbHk6CiAgICAgICAgICAgIHdpdGggY29udGV4dGxpYi5zdXBwcmVzcyhFeGNlcHRpb24pOgogICAgICAgICAgICAgICAgYXdhaXQgYXVkaXQuY2xvc2UoKQoKICAgICAgICBmb3IgZWwgaW4gZWxlbWVudHM6CiAgICAgICAgICAgIGlmIGVsWyJpZCJdIGluIHJlY3RzOgogICAgICAgICAgICAgICAgZWxbInJlY3QiXSA9IHJlY3RzW2VsWyJpZCJdXQoKICAgICAgICAjIDMpIFNjcmVlbiBzaXplIGluIHBvaW50cywgZm9yIG5vcm1hbGl6aW5nIHRoZSByZWN0cy4KICAgICAgICBzY3JlZW4gPSBOb25lCiAgICAgICAgd2l0aCBjb250ZXh0bGliLnN1cHByZXNzKEV4Y2VwdGlvbik6CiAgICAgICAgICAgIHNiID0gU3ByaW5nQm9hcmRTZXJ2aWNlc1NlcnZpY2UobG9ja2Rvd249c2VsZi5yc2QpCiAgICAgICAgICAgIG0gPSBhd2FpdCBfbWF5YmVfYXdhaXQoc2IuZ2V0X2hvbWVzY3JlZW5faWNvbl9tZXRyaWNzKCkpCiAgICAgICAgICAgIHNjcmVlbiA9IHsidyI6IG0uZ2V0KCJob21lU2NyZWVuV2lkdGgiKSwgImgiOiBtLmdldCgiaG9tZVNjcmVlbkhlaWdodCIpfQoKICAgICAgICByZXR1cm4geyJlbGVtZW50cyI6IGVsZW1lbnRzLCAic2NyZWVuIjogc2NyZWVufQoKICAgIGFzeW5jIGRlZiBvcF9waW5nKHNlbGYsIF8pOgogICAgICAgIHJldHVybiB7InBvbmciOiBUcnVlfQoKICAgIGFzeW5jIGRlZiBkaXNwYXRjaChzZWxmLCBtc2cpOgogICAgICAgIG9wID0gbXNnLmdldCgib3AiKQogICAgICAgIGZuID0gZ2V0YXR0cihzZWxmLCBmIm9wX3tvcH0iLCBOb25lKQogICAgICAgIGlmIGZuIGlzIE5vbmU6CiAgICAgICAgICAgIHJhaXNlIFJ1bnRpbWVFcnJvcihmInVua25vd24gb3AgJ3tvcH0nIikKICAgICAgICByZXR1cm4gYXdhaXQgZm4obXNnKQoKICAgIGFzeW5jIGRlZiBjbG9zZShzZWxmKToKICAgICAgICB3aXRoIGNvbnRleHRsaWIuc3VwcHJlc3MoRXhjZXB0aW9uKToKICAgICAgICAgICAgYXdhaXQgc2VsZi5zdGFjay5hY2xvc2UoKQogICAgICAgIGlmIHNlbGYucnNkIGlzIG5vdCBOb25lOgogICAgICAgICAgICB3aXRoIGNvbnRleHRsaWIuc3VwcHJlc3MoRXhjZXB0aW9uKToKICAgICAgICAgICAgICAgIGF3YWl0IHNlbGYucnNkLmNsb3NlKCkKCgpkZWYgX2lzXzkwMjEodGV4dDogc3RyKSAtPiBib29sOgogICAgaW1wb3J0IHJlCiAgICByZXR1cm4gYm9vbChyZS5zZWFyY2gociJjb3JlXHMqZGV2aWNlXHMqZXJyb3JcVyo5MDIxIiwgdGV4dCwgcmUuSSkgb3IgcmUuc2VhcmNoKHIiXGI5MDIxXGIiLCB0ZXh0KSkKCgphc3luYyBkZWYgbWFpbigpOgogICAgdWRpZCA9IHN5cy5hcmd2WzFdCiAgICBwb3J0ID0gaW50KHN5cy5hcmd2WzJdKSBpZiBsZW4oc3lzLmFyZ3YpID4gMiBlbHNlIDQ5MTUxCiAgICBhZ2VudCA9IEFnZW50KHVkaWQsIHBvcnQpCiAgICBvdXQgPSBzeXMuc3Rkb3V0CgogICAgZGVmIGVtaXQob2JqKToKICAgICAgICAjIGRlZmF1bHQ9c3RyIGtlZXBzIGEgc3RyYXkgcGxpc3QgdHlwZSAoYnl0ZXMvZGF0ZXRpbWUgaW4gc3ByaW5nYm9hcmQKICAgICAgICAjIGljb24gc3RhdGUpIGZyb20gY3Jhc2hpbmcgc2VyaWFsaXphdGlvbiBtaWQtc2Vzc2lvbi4KICAgICAgICBvdXQud3JpdGUoanNvbi5kdW1wcyhvYmosIGRlZmF1bHQ9c3RyKSArICJcbiIpCiAgICAgICAgb3V0LmZsdXNoKCkKCiAgICB0cnk6CiAgICAgICAgYXdhaXQgYWdlbnQuY29ubmVjdCgpCiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6ICAjIG5vcWE6IEJMRTAwMQogICAgICAgIGVtaXQoeyJyZWFkeSI6IEZhbHNlLCAiZXJyb3IiOiBzdHIoZSl9KQogICAgICAgIHJldHVybgogICAgZW1pdCh7InJlYWR5IjogVHJ1ZX0pCgogICAgbG9vcCA9IGFzeW5jaW8uZ2V0X2V2ZW50X2xvb3AoKQogICAgcmVhZGVyID0gYXN5bmNpby5TdHJlYW1SZWFkZXIoKQogICAgYXdhaXQgbG9vcC5jb25uZWN0X3JlYWRfcGlwZShsYW1iZGE6IGFzeW5jaW8uU3RyZWFtUmVhZGVyUHJvdG9jb2wocmVhZGVyKSwgc3lzLnN0ZGluKQoKICAgIHdoaWxlIFRydWU6CiAgICAgICAgbGluZSA9IGF3YWl0IHJlYWRlci5yZWFkbGluZSgpCiAgICAgICAgaWYgbm90IGxpbmU6CiAgICAgICAgICAgIGJyZWFrCiAgICAgICAgbGluZSA9IGxpbmUuc3RyaXAoKQogICAgICAgIGlmIG5vdCBsaW5lOgogICAgICAgICAgICBjb250aW51ZQogICAgICAgIHRyeToKICAgICAgICAgICAgbXNnID0ganNvbi5sb2FkcyhsaW5lKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb246ICAjIG5vcWE6IEJMRTAwMQogICAgICAgICAgICBlbWl0KHsiZXJyb3IiOiAiYmFkIGpzb24ifSkKICAgICAgICAgICAgY29udGludWUKICAgICAgICBtaWQgPSBtc2cuZ2V0KCJpZCIpCiAgICAgICAgdHJ5OgogICAgICAgICAgICByZXN1bHQgPSBhd2FpdCBhZ2VudC5kaXNwYXRjaChtc2cpCiAgICAgICAgICAgIGVtaXQoeyJpZCI6IG1pZCwgIm9rIjogVHJ1ZSwgKipyZXN1bHR9KQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTogICMgbm9xYTogQkxFMDAxCiAgICAgICAgICAgIHRleHQgPSBmInt0eXBlKGUpLl9fbmFtZV9ffToge2V9IgogICAgICAgICAgICBlbWl0KHsiaWQiOiBtaWQsICJlcnJvciI6IHRleHQsICJnYXRlZF85MDIxIjogX2lzXzkwMjEodGV4dCl9KQoKICAgIGF3YWl0IGFnZW50LmNsb3NlKCkKCgppZiBfX25hbWVfXyA9PSAiX19tYWluX18iOgogICAgYXN5bmNpby5ydW4obWFpbigpKQo=";

/** Decode the embedded agent program to its Python source. */
export function coreDeviceAgentScript(): string {
  return Buffer.from(AGENT_SCRIPT_B64, "base64").toString("utf8");
}

/**
 * Materialize the agent program to a stable temp path (content-hashed, so a new
 * build's script lands at a new path and an old one is never re-run). Written
 * once; concurrent callers race harmlessly on an identical payload.
 */
export async function materializeAgentScript(): Promise<string> {
  const script = coreDeviceAgentScript();
  const hash = createHash("sha256").update(script).digest("hex").slice(0, 16);
  const path = join(tmpdir(), `argent-coredevice-agent-${hash}.py`);
  // The hash names the path but says nothing about a PRE-EXISTING file's
  // content: on a shared /tmp (Linux) any local user could plant a file at
  // this predictable path and have it executed as us. Never trust an existing
  // file without reading it back; on mismatch fall back to a fresh private
  // path instead of fighting over a file we may not own.
  if (existsSync(path)) {
    try {
      if ((await readFile(path, "utf8")) === script) return path;
    } catch {
      // unreadable — treat as mismatched
    }
    const unique = join(tmpdir(), `argent-coredevice-agent-${hash}-${process.pid}.py`);
    await writeFile(unique, script, { mode: 0o600 });
    return unique;
  }
  await writeFile(path, script, { mode: 0o600 });
  return path;
}

/**
 * Resolve the Python interpreter that has pymobiledevice3 importable. The
 * `pymobiledevice3` CLI is a thin launcher whose shebang points at its venv
 * interpreter (pipx/venv installs), so read the shebang. Falls back to a
 * sibling `python`/`python3` in the same bin dir.
 */
export async function resolvePmd3Python(pmd3CliPath: string): Promise<string> {
  try {
    const head = (await readFile(pmd3CliPath, "utf8")).slice(0, 256);
    const firstLine = head.split("\n", 1)[0] ?? "";
    if (firstLine.startsWith("#!")) {
      const interp = firstLine.slice(2).trim().split(/\s+/)[0];
      // `#!/usr/bin/env python3` (brew/system pip installs) would "resolve" to
      // env itself, which then treats our script path as the command to run —
      // only accept a shebang that points at an actual interpreter binary.
      const basename = interp ? interp.slice(interp.lastIndexOf("/") + 1) : "";
      const isLauncher = ["env", "sh", "bash", "zsh"].includes(basename);
      if (interp && interp.startsWith("/") && !isLauncher && existsSync(interp)) return interp;
    }
  } catch {
    // not a readable script (e.g. a compiled shim) — fall through to siblings
  }
  const binDir = dirname(pmd3CliPath);
  for (const name of ["python3", "python"]) {
    const p = join(binDir, name);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `could not resolve the pymobiledevice3 Python interpreter from "${pmd3CliPath}" ` +
      `(its shebang and sibling python were both unusable)`
  );
}

/** A response line from the agent, keyed by the request `id` we sent. */
interface AgentResponse {
  id?: number;
  ok?: boolean;
  error?: string;
  gated_9021?: boolean;
  [k: string]: unknown;
}

/** Raised when the agent replies with an `error` (carries the 9021 hint). */
export class CoreDeviceAgentError extends Error {
  readonly gated9021: boolean;
  constructor(message: string, gated9021: boolean) {
    super(message);
    this.name = "CoreDeviceAgentError";
    this.gated9021 = gated9021;
  }
}

/**
 * One long-lived pymobiledevice3 process per physical iPhone. Connects the RSD
 * tunnel and opens the HID/screenshot services once, then serves JSON commands
 * on stdio — so each tap/screenshot/button costs a socket write, not a fresh
 * ~0.8s Python cold-start (of which ~0.5s is just `import pymobiledevice3`).
 *
 * Requests are id-correlated; the caller may have several in flight, though the
 * device serializes them anyway.
 */
export class CoreDeviceAgent {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: AgentResponse) => void; reject: (e: Error) => void }
  >();
  private startError: Error | null = null;
  private exited = false;

  constructor(
    private readonly python: string,
    private readonly scriptPath: string,
    private readonly udid: string,
    private readonly tunneldPort: number,
    private readonly startTimeoutMs = 30_000
  ) {}

  /** Spawn the agent and wait for its `{"ready":true}` handshake line. */
  async start(): Promise<void> {
    const proc = spawn(this.python, [this.scriptPath, this.udid, String(this.tunneldPort)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      // pymobiledevice3 logs to stderr; keep a bounded tail for diagnostics.
      stderr = (stderr + d.toString()).slice(-4000);
    });

    const rl = createInterface({ input: proc.stdout });
    this.rl = rl;

    // Captured so the exit/error handlers below can fail the handshake
    // immediately — without this, an agent that dies at spawn (bad
    // interpreter, python syntax error) only surfaces via the full
    // startTimeoutMs timer. Rejecting an already-settled promise is a no-op.
    let rejectReady: (err: Error) => void = () => {};

    const ready = new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      // `onLine` and `timer` reference each other; `timer` is only read from
      // inside `onLine`, which never runs before `timer` is assigned below.
      const onLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: AgentResponse;
        try {
          msg = JSON.parse(trimmed) as AgentResponse;
        } catch {
          return; // ignore any non-JSON noise before the handshake
        }
        if ("ready" in msg) {
          clearTimeout(timer);
          rl.off("line", onLine);
          if (msg.ready) {
            rl.on("line", (l) => this.onResponse(l));
            resolve();
          } else {
            reject(new Error(String(msg.error ?? "agent failed to connect")));
          }
        }
      };
      const timer = setTimeout(() => {
        rl.off("line", onLine);
        reject(
          new Error(
            `CoreDevice agent did not become ready within ${this.startTimeoutMs}ms` +
              (stderr ? `; last stderr: ${stderr.slice(-300)}` : "")
          )
        );
      }, this.startTimeoutMs);
      rl.on("line", onLine);
    });

    proc.on("exit", (code, signal) => {
      this.exited = true;
      const err = new Error(
        `CoreDevice agent exited (code=${code}, signal=${signal})` +
          (stderr ? `; stderr: ${stderr.slice(-300)}` : "")
      );
      this.startError ??= err;
      rejectReady(err);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    // Without an "error" listener a spawn-layer failure (EACCES, EMFILE, …)
    // is an unhandled 'error' event and takes down the whole tool-server.
    proc.on("error", (cause) => {
      this.exited = true;
      const err = new Error(`CoreDevice agent failed to spawn: ${cause.message}`, { cause });
      this.startError ??= err;
      rejectReady(err);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    try {
      await ready;
    } catch (err) {
      this.dispose();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private onResponse(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: AgentResponse;
    try {
      msg = JSON.parse(trimmed) as AgentResponse;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      waiter.reject(new CoreDeviceAgentError(String(msg.error), Boolean(msg.gated_9021)));
    } else {
      waiter.resolve(msg);
    }
  }

  /** Send one op and await its correlated response. */
  request(
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs = 30_000
  ): Promise<AgentResponse> {
    if (this.exited || !this.proc) {
      return Promise.reject(this.startError ?? new Error("CoreDevice agent is not running"));
    }
    const id = this.nextId++;
    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`CoreDevice ${op} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc!.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }

  dispose(): void {
    this.exited = true;
    this.rl?.close();
    this.rl = null;
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    for (const { reject } of this.pending.values()) {
      reject(new Error("CoreDevice agent disposed"));
    }
    this.pending.clear();
  }
}
