import type { Registry } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import { type DescribeNode, type DescribeResult, parseDescribeResult } from "./contract";

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function roundNormalized(v: number): number {
  return Math.round(v * 1e12) / 1e12;
}

interface RnNode {
  i: number;
  p: number;
  n?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  t?: string;
  d?: string;
  l?: string;
}
interface RnResult {
  screenW?: number;
  screenH?: number;
  nodes?: RnNode[];
  error?: string;
}

/**
 * Self-contained script injected via plain Runtime.evaluate. Walks the React
 * fiber tree and measures EVERY host component itself via Fabric's
 * synchronous `nativeFabricUIManager.measure` (page coords), rather than going
 * through `makeComponentTreeScript` — whose own measurement path yields null
 * rects for some apps even though the Fabric primitive works fine. Returns a
 * JSON string `{ screenW, screenH, nodes:[{i,p,n,x,y,w,h,t,d,l}] }`.
 */
const FIBER_MEASURE_SCRIPT = `(function(){try{
var g=globalThis;var fm=g.nativeFabricUIManager;
if(!fm)return JSON.stringify({error:"no-fabric"});
var hook=g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
if(!hook||!hook.renderers)return JSON.stringify({error:"no-hook"});
var root=null;
hook.renderers.forEach(function(_,id){if(root)return;try{var rs=hook.getFiberRoots&&hook.getFiberRoots(id);if(rs&&rs.size){rs.forEach(function(r){if(!root)root=r;});}}catch(e){}});
if(!root||!root.current)return JSON.stringify({error:"no-root"});
function compName(f){var c=f;for(var i=0;i<40&&c;i++){var t=c.type;if(t&&typeof t!=='string'){var n=t.displayName||t.name;if(n)return n;}c=c.return;}return null;}
function hostName(t){if(t.indexOf('RCT')===0)t=t.slice(3);if(t.indexOf('TextInput')>=0)return 'TextInput';if(t==='Paragraph')return 'Text';return t;}
var nodes=[],idxByFiber=new Map(),stack=[root.current],guard=0,sw=0,sh=0;
while(stack.length){var f=stack.pop();if(!f){continue;}if(++guard>80000)break;
if(typeof f.type==='string'&&f.stateNode){var sn=f.stateNode,r=null;
try{if(sn.node){fm.measure(sn.node,function(x,y,w,h,px,py){r={x:px,y:py,w:w,h:h};});}}catch(e){}
if(r&&typeof r.w==='number'&&typeof r.h==='number'){var props=f.memoizedProps||{};var txt=null;
if(typeof props.children==='string')txt=props.children;else if(typeof props.text==='string')txt=props.text;
else if(props.children&&typeof props.children==='object'&&!Array.isArray(props.children)&&props.children.props&&typeof props.children.props.children==='string')txt=props.children.props.children;
if(txt==null&&f.type.indexOf('TextInput')>=0)txt=(props.value&&String(props.value))||(props.placeholder&&String(props.placeholder))||null;
var p=-1,a=f.return;while(a){if(idxByFiber.has(a)){p=idxByFiber.get(a);break;}a=a.return;}
var id=nodes.length;idxByFiber.set(f,id);
if(r.x===0&&r.y===0){if(r.w>sw)sw=r.w;if(r.h>sh)sh=r.h;}
nodes.push({i:id,p:p,n:compName(f)||hostName(f.type),x:r.x,y:r.y,w:r.w,h:r.h,
t:(typeof txt==='string'&&txt.length<=120)?txt:undefined,
d:(props.testID!=null&&String(props.testID).slice(0,120))||undefined,
l:(props.accessibilityLabel!=null&&String(props.accessibilityLabel).slice(0,160))||undefined});}}
if(f.sibling)stack.push(f.sibling);if(f.child)stack.push(f.child);}
if(!sw||!sh){for(var k=0;k<nodes.length;k++){var nn=nodes[k];if(nn.x+nn.w>sw)sw=nn.x+nn.w;if(nn.y+nn.h>sh)sh=nn.y+nn.h;}}
return JSON.stringify({screenW:sw,screenH:sh,nodes:nodes});
}catch(e){return JSON.stringify({error:String((e&&e.message)||e)});}})()`;

/**
 * Preview-only element tree for React Native apps.
 *
 * Produces the FULL on-screen element tree (every measured host view,
 * including non-accessibility container views), so the preview UI can anchor
 * a variant card / comment spotlight to the *actual* element instead of the
 * coarse interactive-only subset the iOS ax-service exposes.
 *
 * `describe` tool behaviour is intentionally NOT touched: this is a separate
 * path used only by `GET /preview/describe`. Returns `null` whenever a RN
 * Fabric runtime is not reachable / yields no usable on-screen rects (the
 * caller then falls back to the regular `describe` tool); never throws into
 * the HTTP layer, never returns an empty tree (no regression).
 */
export async function buildRnPreviewTree(
  registry: Registry,
  udid: string,
  port = 8081
): Promise<DescribeResult | null> {
  let api: JsRuntimeDebuggerApi;
  try {
    api = await registry.resolveService<JsRuntimeDebuggerApi>(`JsRuntimeDebugger:${port}:${udid}`);
  } catch {
    return null; // Metro / RN debugger not reachable → caller falls back
  }

  let parsed: RnResult;
  try {
    const raw = await api.cdp.evaluate(FIBER_MEASURE_SCRIPT, { timeout: 15_000 });
    if (typeof raw !== "string") return null;
    parsed = JSON.parse(raw) as RnResult;
  } catch {
    return null;
  }
  if (parsed.error || !Array.isArray(parsed.nodes)) return null;
  const sw = parsed.screenW;
  const sh = parsed.screenH;
  if (!(typeof sw === "number" && sw > 0) || !(typeof sh === "number" && sh > 0)) {
    return null;
  }

  // One DescribeNode per measured fiber that is actually on-screen (positive
  // normalized area after clamping the page rect into [0,1]). Off-screen /
  // scrolled-away content clamps to zero area and is dropped. Nesting is kept
  // via `p` so vpMatchNode / vpNodeAtPoint still resolve the smallest
  // containing node precisely.
  const nodeByIdx = new Map<number, DescribeNode>();
  const order: number[] = [];
  const raw = parsed.nodes;
  for (const e of raw) {
    // Defense-in-depth: a non-object array element (adversarial / malformed
    // payload) must not throw out of the adapter — return-null-then-fallback
    // is the contract, independent of the caller's own try/catch.
    if (!e || typeof e !== "object") continue;
    if (
      typeof e.x !== "number" ||
      typeof e.y !== "number" ||
      typeof e.w !== "number" ||
      typeof e.h !== "number"
    ) {
      continue;
    }
    const x1 = clamp01(e.x / sw);
    const y1 = clamp01(e.y / sh);
    const x2 = clamp01((e.x + e.w) / sw);
    const y2 = clamp01((e.y + e.h) / sh);
    const width = x2 - x1;
    const height = y2 - y1;
    if (width <= 0 || height <= 0) continue;
    const node: DescribeNode = {
      role: e.n || "View",
      frame: {
        x: roundNormalized(x1),
        y: roundNormalized(y1),
        width: roundNormalized(width),
        height: roundNormalized(height),
      },
      children: [],
    };
    if (e.l) node.label = e.l;
    if (e.d) node.identifier = e.d;
    if (e.t) node.value = e.t;
    nodeByIdx.set(e.i, node);
    order.push(e.i);
  }

  // No fiber yielded a usable on-screen rect — returning an empty tree would
  // be a regression vs the ax-service fallback, so bail and let the caller
  // use the regular `describe` tool instead.
  if (order.length === 0) return null;

  const byI = new Map<number, RnNode>();
  for (const e of raw) if (e && typeof e === "object") byI.set(e.i, e);

  const root: DescribeNode = {
    role: "AXGroup",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [],
  };

  // Nearest emitted ancestor (climb `p` through dropped/off-screen wrappers
  // so a skipped parent doesn't flatten its descendants to the root).
  const effectiveParent = (i: number): DescribeNode => {
    let p = byI.get(i)?.p ?? -1;
    const guard = new Set<number>();
    while (p >= 0 && !nodeByIdx.has(p) && !guard.has(p)) {
      guard.add(p);
      p = byI.get(p)?.p ?? -1;
    }
    return p >= 0 ? (nodeByIdx.get(p) ?? root) : root;
  };

  for (const i of order) {
    effectiveParent(i).children.push(nodeByIdx.get(i)!);
  }

  return { tree: parseDescribeResult(root), source: "native-devtools" };
}
