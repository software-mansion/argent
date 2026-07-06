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
 * Source of truth: `coredevice-agent.py.b64` sits next to this file; regenerate
 * with `base64 -i coredevice-agent.py | tr -d '\n'`. The decoded script speaks
 * newline-delimited JSON on stdio (see AGENT_PROTOCOL below).
 */
const AGENT_SCRIPT_B64 =
  "IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJQZXJzaXN0ZW50IENvcmVEZXZpY2UgYWdlbnQg4oCUIG9uZSBsb25nLWxpdmVkIHByb2Nlc3MgcGVyIHBoeXNpY2FsIGlQaG9uZS4KClJlcGxhY2VzIHBlci1jYWxsIGBweW1vYmlsZWRldmljZTNgIENMSSBzcGF3bnMgKGVhY2ggfjAuOHMsIH4wLjVzIGp1c3QgdGhlClB5dGhvbiBpbXBvcnQpIHdpdGggYSBzaW5nbGUgcHJvY2VzcyB0aGF0IGNvbm5lY3RzIHRoZSBSU0QgdHVubmVsIG9uY2UsIGhvbGRzCnRoZSB0b3VjaHNjcmVlbiBtZWRpYS1zdHJlYW0gc2Vzc2lvbiArIHNjcmVlbnNob3Qgc2VydmljZSBvcGVuLCBhbmQgZXhlY3V0ZXMKbmV3bGluZS1kZWxpbWl0ZWQgSlNPTiBjb21tYW5kcyBvbiBzdGRpbiwgcmVwbHlpbmcgd2l0aCBvbmUgSlNPTiBsaW5lIGVhY2guCgpSZXVzZXMgcHltb2JpbGVkZXZpY2UzJ3Mgb3duIENMSSBoZWxwZXJzIHNvIGJlaGF2aW91ciBpcyBpZGVudGljYWwgdG8gdGhlCmBkZXZlbG9wZXIgY29yZS1kZXZpY2Ug4oCmYCBjb21tYW5kcyAoZHdlbGwtZHJhZyB0YXAsIG1haW5Ub3VjaHNjcmVlbiByZXBvcnRzLApJbmRpZ28gaGFyZHdhcmUgYnV0dG9ucywgc2NyZWVuLWNhcHR1cmUgUE5HKS4KClByb3RvY29sIChvbmUgSlNPTiBvYmplY3QgcGVyIGxpbmUpOgogIDwtIHsidWRpZCI6ICIuLi4iLCAicG9ydCI6IDQ5MTUxfSAgICAgICAgICAgICAgICAgKGFyZ3YsIG5vdCBzdGRpbikKICAtPiB7InJlYWR5IjogdHJ1ZX0gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAob3IgeyJyZWFkeSI6IGZhbHNlLCAiZXJyb3IiOiAiLi4uIn0pCiAgPC0geyJpZCI6IDEsICJvcCI6ICJzY3JlZW5zaG90In0KICAtPiB7ImlkIjogMSwgIm9rIjogdHJ1ZSwgImltYWdlX2I2NCI6ICIuLi4ifQogIDwtIHsiaWQiOiAyLCAib3AiOiAidGFwIiwgIngiOiAzMjc2OCwgInkiOiAyMDAwMH0gICAgICAgICAgKHgveSBhbHJlYWR5IDAuLjY1NTM1KQogIDwtIHsiaWQiOiAzLCAib3AiOiAic3dpcGUiLCAieDEiOi4uLCAieTEiOi4uLCAieDIiOi4uLCAieTIiOi4uLCAic3RlcHMiOjE5LCAiZHVyYXRpb24iOjAuM30KICA8LSB7ImlkIjogNCwgIm9wIjogImJ1dHRvbiIsICJuYW1lIjogImhvbWUifQogIDwtIHsiaWQiOiA1LCAib3AiOiAiaG9tZXNjcmVlbiJ9ICAgICAgICAgICAgICAgICAgICAgICAgICAgIChzcHJpbmdib2FyZCBpY29uIGdyaWQpCiAgLT4geyJpZCI6IE4sICJvayI6IHRydWUsIC4uLn0gIHwgIHsiaWQiOiBOLCAiZXJyb3IiOiAiLi4uIiwgImdhdGVkXzkwMjEiOiBib29sfQoiIiIKaW1wb3J0IGFzeW5jaW8KaW1wb3J0IGJhc2U2NAppbXBvcnQgY29udGV4dGxpYgppbXBvcnQganNvbgppbXBvcnQgc3lzCgpmcm9tIHB5bW9iaWxlZGV2aWNlMy5yZW1vdGUucmVtb3RlX3NlcnZpY2VfZGlzY292ZXJ5IGltcG9ydCBSZW1vdGVTZXJ2aWNlRGlzY292ZXJ5U2VydmljZQpmcm9tIHB5bW9iaWxlZGV2aWNlMy5yZW1vdGUuY29yZV9kZXZpY2UuaGlkX3NlcnZpY2UgaW1wb3J0ICgKICAgIHRvdWNoX3Nlc3Npb24sCiAgICBJbmRpZ29ISURTZXJ2aWNlLAogICAgRElHSVRJWkVSX1NVUkZBQ0VfTUFJTl9UT1VDSFNDUkVFTiwKKQpmcm9tIHB5bW9iaWxlZGV2aWNlMy5yZW1vdGUuY29yZV9kZXZpY2Uuc2NyZWVuX2NhcHR1cmVfc2VydmljZSBpbXBvcnQgU2NyZWVuQ2FwdHVyZVNlcnZpY2UKZnJvbSBweW1vYmlsZWRldmljZTMuc2VydmljZXMuc3ByaW5nYm9hcmQgaW1wb3J0IFNwcmluZ0JvYXJkU2VydmljZXNTZXJ2aWNlCmZyb20gcHltb2JpbGVkZXZpY2UzLmNsaS5kZXZlbG9wZXIuY29yZV9kZXZpY2UgaW1wb3J0IF9kb19kcmFnLCBfc2VuZF9idXR0b25fcHJlc3MsIF9OQU1FRF9CVVRUT05TCgppbXBvcnQgdXJsbGliLnJlcXVlc3QKCgpkZWYgX3Jlc29sdmVfcnNkKHVkaWQ6IHN0ciwgcG9ydDogaW50KToKICAgIHBheWxvYWQgPSBqc29uLmxvYWQodXJsbGliLnJlcXVlc3QudXJsb3BlbihmImh0dHA6Ly8xMjcuMC4wLjE6e3BvcnR9LyIsIHRpbWVvdXQ9NCkpCiAgICBlbnRyeSA9IHBheWxvYWQuZ2V0KHVkaWQpIG9yIFtdCiAgICB0ID0gZW50cnlbMF0gaWYgZW50cnkgZWxzZSB7fQogICAgYWRkciwgdHBvcnQgPSB0LmdldCgidHVubmVsLWFkZHJlc3MiKSwgdC5nZXQoInR1bm5lbC1wb3J0IikKICAgIGlmIG5vdCBhZGRyIG9yIG5vdCB0cG9ydDoKICAgICAgICByYWlzZSBSdW50aW1lRXJyb3IoZiJubyBhY3RpdmUgdHVubmVsIHJlZ2lzdGVyZWQgZm9yIHt1ZGlkfSBvbiB0dW5uZWxkIDp7cG9ydH0iKQogICAgcmV0dXJuIGFkZHIsIGludCh0cG9ydCkKCgphc3luYyBkZWYgX21heWJlX2F3YWl0KHYpOgogICAgcmV0dXJuIGF3YWl0IHYgaWYgYXN5bmNpby5pc2Nvcm91dGluZSh2KSBlbHNlIHYKCgpjbGFzcyBBZ2VudDoKICAgIGRlZiBfX2luaXRfXyhzZWxmLCB1ZGlkOiBzdHIsIHBvcnQ6IGludCk6CiAgICAgICAgc2VsZi51ZGlkID0gdWRpZAogICAgICAgIHNlbGYucG9ydCA9IHBvcnQKICAgICAgICBzZWxmLnJzZCA9IE5vbmUKICAgICAgICBzZWxmLnN0YWNrID0gY29udGV4dGxpYi5Bc3luY0V4aXRTdGFjaygpCiAgICAgICAgc2VsZi50b3VjaCA9IE5vbmUgICMgVW5pdmVyc2FsSElEU2VydmljZVNlcnZpY2UsIGhlbGQgb3BlbiAobWVkaWEgc3RyZWFtIHN0YXlzIHdhcm0pCgogICAgYXN5bmMgZGVmIGNvbm5lY3Qoc2VsZik6CiAgICAgICAgYWRkciwgdHBvcnQgPSBfcmVzb2x2ZV9yc2Qoc2VsZi51ZGlkLCBzZWxmLnBvcnQpCiAgICAgICAgc2VsZi5yc2QgPSBSZW1vdGVTZXJ2aWNlRGlzY292ZXJ5U2VydmljZSgoYWRkciwgdHBvcnQpKQogICAgICAgIGF3YWl0IHNlbGYucnNkLmNvbm5lY3QoKQoKICAgIGFzeW5jIGRlZiBfZW5zdXJlX3RvdWNoKHNlbGYpOgogICAgICAgICMgTGF6aWx5IG9wZW4gKGFuZCBrZWVwKSB0aGUgdG91Y2hzY3JlZW4gbWVkaWEtc3RyZWFtIHNlc3Npb24g4oCUIHRoZSBhdXRoCiAgICAgICAgIyBnYXRlIGJhY2tib2FyZGQgbmVlZHMgZm9yIGluamVjdGVkIHRvdWNoZXMuIEtlcHQgd2FybSBzbyB0YXBzIGRvbid0IHBheQogICAgICAgICMgdGhlIG1lZGlhLXN0cmVhbSBzdGFydHVwIGVhY2ggdGltZS4KICAgICAgICBpZiBzZWxmLnRvdWNoIGlzIE5vbmU6CiAgICAgICAgICAgIHNlbGYudG91Y2ggPSBhd2FpdCBzZWxmLnN0YWNrLmVudGVyX2FzeW5jX2NvbnRleHQodG91Y2hfc2Vzc2lvbihzZWxmLnJzZCkpCiAgICAgICAgcmV0dXJuIHNlbGYudG91Y2gKCiAgICBhc3luYyBkZWYgb3Bfc2NyZWVuc2hvdChzZWxmLCBfKToKICAgICAgICAjIFNjcmVlbkNhcHR1cmVTZXJ2aWNlIGRlbGl2ZXJzIG9uZSBQTkcgcGVyIG9wZW4gKHRoZSBzdHJlYW0gZW5kcyBhZnRlcgogICAgICAgICMgdGhlIGZyYW1lKSwgc28gb3BlbiBhIGZyZXNoIG9uZSBlYWNoIGNhbGwg4oCUIGNoZWFwIG5vdyB0aGUgaW50ZXJwcmV0ZXIKICAgICAgICAjIGFuZCB0dW5uZWwgYXJlIGFscmVhZHkgd2FybS4KICAgICAgICBhc3luYyB3aXRoIFNjcmVlbkNhcHR1cmVTZXJ2aWNlKHNlbGYucnNkKSBhcyBzY3JlZW46CiAgICAgICAgICAgIHJlc3AgPSBhd2FpdCBzY3JlZW4uY2FwdHVyZV9zY3JlZW5zaG90KCkKICAgICAgICByZXR1cm4geyJpbWFnZV9iNjQiOiBiYXNlNjQuYjY0ZW5jb2RlKHJlc3BbImltYWdlIl0pLmRlY29kZSgiYXNjaWkiKX0KCiAgICBhc3luYyBkZWYgb3BfdGFwKHNlbGYsIG1zZyk6CiAgICAgICAgc3ZjID0gYXdhaXQgc2VsZi5fZW5zdXJlX3RvdWNoKCkKICAgICAgICB4LCB5ID0gaW50KG1zZ1sieCJdKSwgaW50KG1zZ1sieSJdKQogICAgICAgICMgWmVyby1kd2VsbCB0YXBzIGFyZSBkcm9wcGVkIGJ5IGlPUzsgZW1pdCBhIHNob3J0IGhlbGQgZHJhZyB3aXRoIGEgdGlueQogICAgICAgICMgbW92ZSBhd2F5IGZyb20gdGhlIGVkZ2UgKG1pcnJvcnMgY29yZS1kZXZpY2UudHMgLyB0aGUgQ0xJIGRyYWcgcGF0aCkuCiAgICAgICAgeTIgPSB5ICsgOTYgaWYgeSA8PSA2NTUzNSAtIDEyMCBlbHNlIHkgLSA5NgogICAgICAgIGF3YWl0IF9kb19kcmFnKHN2YywgeCwgeSwgeCwgeTIsIDMsIDAuMTUsIHRzaWQ9RElHSVRJWkVSX1NVUkZBQ0VfTUFJTl9UT1VDSFNDUkVFTikKICAgICAgICByZXR1cm4ge30KCiAgICBhc3luYyBkZWYgb3Bfc3dpcGUoc2VsZiwgbXNnKToKICAgICAgICBzdmMgPSBhd2FpdCBzZWxmLl9lbnN1cmVfdG91Y2goKQogICAgICAgIGF3YWl0IF9kb19kcmFnKAogICAgICAgICAgICBzdmMsIGludChtc2dbIngxIl0pLCBpbnQobXNnWyJ5MSJdKSwgaW50KG1zZ1sieDIiXSksIGludChtc2dbInkyIl0pLAogICAgICAgICAgICBpbnQobXNnLmdldCgic3RlcHMiLCAxOSkpLCBmbG9hdChtc2cuZ2V0KCJkdXJhdGlvbiIsIDAuMykpLAogICAgICAgICAgICB0c2lkPURJR0lUSVpFUl9TVVJGQUNFX01BSU5fVE9VQ0hTQ1JFRU4sCiAgICAgICAgKQogICAgICAgIHJldHVybiB7fQoKICAgIGFzeW5jIGRlZiBvcF9idXR0b24oc2VsZiwgbXNnKToKICAgICAgICBuYW1lID0gbXNnWyJuYW1lIl0KICAgICAgICBpZiBuYW1lIG5vdCBpbiBfTkFNRURfQlVUVE9OUzoKICAgICAgICAgICAgcmFpc2UgUnVudGltZUVycm9yKGYidW5rbm93biBidXR0b24gJ3tuYW1lfSciKQogICAgICAgIHVzYWdlX3BhZ2UsIHVzYWdlX2NvZGUsIGhvbGQgPSBfTkFNRURfQlVUVE9OU1tuYW1lXQogICAgICAgIGFzeW5jIHdpdGggSW5kaWdvSElEU2VydmljZShzZWxmLnJzZCkgYXMgc3ZjOgogICAgICAgICAgICBhd2FpdCBfc2VuZF9idXR0b25fcHJlc3Moc3ZjLCB1c2FnZV9wYWdlLCB1c2FnZV9jb2RlLCAicHJlc3MiLCBob2xkKQogICAgICAgIHJldHVybiB7fQoKICAgIGFzeW5jIGRlZiBvcF9ob21lc2NyZWVuKHNlbGYsIF8pOgogICAgICAgIHNiID0gU3ByaW5nQm9hcmRTZXJ2aWNlc1NlcnZpY2UobG9ja2Rvd249c2VsZi5yc2QpCiAgICAgICAgaWNvbnMgPSBhd2FpdCBfbWF5YmVfYXdhaXQoc2IuZ2V0X2ljb25fc3RhdGUoKSkKICAgICAgICBtZXRyaWNzID0gYXdhaXQgX21heWJlX2F3YWl0KHNiLmdldF9ob21lc2NyZWVuX2ljb25fbWV0cmljcygpKQogICAgICAgIHJldHVybiB7Imljb25fc3RhdGUiOiBpY29ucywgIm1ldHJpY3MiOiBtZXRyaWNzfQoKICAgIGFzeW5jIGRlZiBvcF9waW5nKHNlbGYsIF8pOgogICAgICAgIHJldHVybiB7InBvbmciOiBUcnVlfQoKICAgIGFzeW5jIGRlZiBkaXNwYXRjaChzZWxmLCBtc2cpOgogICAgICAgIG9wID0gbXNnLmdldCgib3AiKQogICAgICAgIGZuID0gZ2V0YXR0cihzZWxmLCBmIm9wX3tvcH0iLCBOb25lKQogICAgICAgIGlmIGZuIGlzIE5vbmU6CiAgICAgICAgICAgIHJhaXNlIFJ1bnRpbWVFcnJvcihmInVua25vd24gb3AgJ3tvcH0nIikKICAgICAgICByZXR1cm4gYXdhaXQgZm4obXNnKQoKICAgIGFzeW5jIGRlZiBjbG9zZShzZWxmKToKICAgICAgICB3aXRoIGNvbnRleHRsaWIuc3VwcHJlc3MoRXhjZXB0aW9uKToKICAgICAgICAgICAgYXdhaXQgc2VsZi5zdGFjay5hY2xvc2UoKQogICAgICAgIGlmIHNlbGYucnNkIGlzIG5vdCBOb25lOgogICAgICAgICAgICB3aXRoIGNvbnRleHRsaWIuc3VwcHJlc3MoRXhjZXB0aW9uKToKICAgICAgICAgICAgICAgIGF3YWl0IHNlbGYucnNkLmNsb3NlKCkKCgpkZWYgX2lzXzkwMjEodGV4dDogc3RyKSAtPiBib29sOgogICAgaW1wb3J0IHJlCiAgICByZXR1cm4gYm9vbChyZS5zZWFyY2gociJjb3JlXHMqZGV2aWNlXHMqZXJyb3JcVyo5MDIxIiwgdGV4dCwgcmUuSSkgb3IgcmUuc2VhcmNoKHIiXGI5MDIxXGIiLCB0ZXh0KSkKCgphc3luYyBkZWYgbWFpbigpOgogICAgdWRpZCA9IHN5cy5hcmd2WzFdCiAgICBwb3J0ID0gaW50KHN5cy5hcmd2WzJdKSBpZiBsZW4oc3lzLmFyZ3YpID4gMiBlbHNlIDQ5MTUxCiAgICBhZ2VudCA9IEFnZW50KHVkaWQsIHBvcnQpCiAgICBvdXQgPSBzeXMuc3Rkb3V0CgogICAgZGVmIGVtaXQob2JqKToKICAgICAgICAjIGRlZmF1bHQ9c3RyIGtlZXBzIGEgc3RyYXkgcGxpc3QgdHlwZSAoYnl0ZXMvZGF0ZXRpbWUgaW4gc3ByaW5nYm9hcmQKICAgICAgICAjIGljb24gc3RhdGUpIGZyb20gY3Jhc2hpbmcgc2VyaWFsaXphdGlvbiBtaWQtc2Vzc2lvbi4KICAgICAgICBvdXQud3JpdGUoanNvbi5kdW1wcyhvYmosIGRlZmF1bHQ9c3RyKSArICJcbiIpCiAgICAgICAgb3V0LmZsdXNoKCkKCiAgICB0cnk6CiAgICAgICAgYXdhaXQgYWdlbnQuY29ubmVjdCgpCiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6ICAjIG5vcWE6IEJMRTAwMQogICAgICAgIGVtaXQoeyJyZWFkeSI6IEZhbHNlLCAiZXJyb3IiOiBzdHIoZSl9KQogICAgICAgIHJldHVybgogICAgZW1pdCh7InJlYWR5IjogVHJ1ZX0pCgogICAgbG9vcCA9IGFzeW5jaW8uZ2V0X2V2ZW50X2xvb3AoKQogICAgcmVhZGVyID0gYXN5bmNpby5TdHJlYW1SZWFkZXIoKQogICAgYXdhaXQgbG9vcC5jb25uZWN0X3JlYWRfcGlwZShsYW1iZGE6IGFzeW5jaW8uU3RyZWFtUmVhZGVyUHJvdG9jb2wocmVhZGVyKSwgc3lzLnN0ZGluKQoKICAgIHdoaWxlIFRydWU6CiAgICAgICAgbGluZSA9IGF3YWl0IHJlYWRlci5yZWFkbGluZSgpCiAgICAgICAgaWYgbm90IGxpbmU6CiAgICAgICAgICAgIGJyZWFrCiAgICAgICAgbGluZSA9IGxpbmUuc3RyaXAoKQogICAgICAgIGlmIG5vdCBsaW5lOgogICAgICAgICAgICBjb250aW51ZQogICAgICAgIHRyeToKICAgICAgICAgICAgbXNnID0ganNvbi5sb2FkcyhsaW5lKQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb246ICAjIG5vcWE6IEJMRTAwMQogICAgICAgICAgICBlbWl0KHsiZXJyb3IiOiAiYmFkIGpzb24ifSkKICAgICAgICAgICAgY29udGludWUKICAgICAgICBtaWQgPSBtc2cuZ2V0KCJpZCIpCiAgICAgICAgdHJ5OgogICAgICAgICAgICByZXN1bHQgPSBhd2FpdCBhZ2VudC5kaXNwYXRjaChtc2cpCiAgICAgICAgICAgIGVtaXQoeyJpZCI6IG1pZCwgIm9rIjogVHJ1ZSwgKipyZXN1bHR9KQogICAgICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTogICMgbm9xYTogQkxFMDAxCiAgICAgICAgICAgIHRleHQgPSBmInt0eXBlKGUpLl9fbmFtZV9ffToge2V9IgogICAgICAgICAgICBlbWl0KHsiaWQiOiBtaWQsICJlcnJvciI6IHRleHQsICJnYXRlZF85MDIxIjogX2lzXzkwMjEodGV4dCl9KQoKICAgIGF3YWl0IGFnZW50LmNsb3NlKCkKCgppZiBfX25hbWVfXyA9PSAiX19tYWluX18iOgogICAgYXN5bmNpby5ydW4obWFpbigpKQo=";

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
  if (!existsSync(path)) {
    await writeFile(path, script, { mode: 0o600 });
  }
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
      if (interp && interp.startsWith("/") && existsSync(interp)) return interp;
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

    const ready = new Promise<void>((resolve, reject) => {
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
