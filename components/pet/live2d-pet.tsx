"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// 页内桌宠「小邻」：右下角 Live2D 看板娘，可拖拽、可对话。
// 对话走 /api/pet/chat（轻量端点，不写会话库）；Live2D 渲染用 pixi-live2d-display，
// Cubism2 运行时与模型资产都在 public/pet/ 下，全部本地加载，无外部 CDN 依赖。
// 模型加载失败时自动降级为 CSS 表情桌宠，对话能力不受影响。

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const CORE_URL = `${BASE_PATH}/pet/core/live2d.core.js`;

// 可切换角色：全部是本地 public/pet/model/ 下的 Cubism2 模型（npm live2d-widget-model-* 系列包）。
// 注意 haru 包内的模型文件也叫 shizuku.model.json（历史命名），路径以目录为准。
const MODELS: { id: string; label: string; url: string }[] = [
  {
    id: "shizuku",
    label: "雫 shizuku",
    url: `${BASE_PATH}/pet/model/shizuku/shizuku.model.json`,
  },
  {
    id: "haru",
    label: "春 haru",
    url: `${BASE_PATH}/pet/model/haru/shizuku.model.json`,
  },
  {
    id: "miku",
    label: "初音 miku",
    url: `${BASE_PATH}/pet/model/miku/miku.model.json`,
  },
  {
    id: "koharu",
    label: "小春 koharu",
    url: `${BASE_PATH}/pet/model/koharu/koharu.model.json`,
  },
  {
    id: "tororo",
    label: "白猫 tororo",
    url: `${BASE_PATH}/pet/model/tororo/tororo.model.json`,
  },
];

const CANVAS_W = 180;
const CANVAS_H = 220;
const MODEL_H = 200;

const HIDDEN_KEY = "pet:hidden";
const DRAG_KEY = "pet:drag";
const MODEL_KEY = "pet:model";
const BUBBLE_AUTOHIDE_MS = 12_000;

type ChatTurn = { role: "user" | "assistant"; text: string };
type PetMode = "loading" | "live2d" | "emoji";

type DragOffset = { dx: number; dy: number };

let modelRefHolder: {
  internalModel?: {
    motionManager?: {
      expressionManager?: {
        setRandomExpression?: () => void;
      };
    };
  };
} | null = null;

// Cubism2 运行时（public/pet/core/live2d.core.js）是 ES 模块，导出全局 Live2D。
// 用一段内联 module script 加载它，加载完成派发事件。
function loadCubism2Core(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("no window"));
  }
  const w = window as typeof window & { Live2D?: unknown };
  if (w.Live2D) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("cubism2 core timeout"));
    }, 12_000);
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pet-live2d-core", onReady);
    };
    window.addEventListener("pet-live2d-core", onReady, { once: true });

    if (!document.getElementById("pet-live2d-core-loader")) {
      const script = document.createElement("script");
      script.type = "module";
      script.id = "pet-live2d-core-loader";
      script.textContent = [
        // Cubism2 核心以 ES 模块提供，pixi-live2d-display 需要其全部类暴露为全局符号
        `import * as L2DCore from ${JSON.stringify(CORE_URL)};`,
        "Object.assign(window, L2DCore);",
        'window.dispatchEvent(new Event("pet-live2d-core"));',
      ].join("\n");
      document.head.appendChild(script);
    }
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function CampusPet() {
  const [hidden, setHidden] = useState(false);
  const [mode, setMode] = useState<PetMode>("loading");
  const [petId, setPetId] = useState<string>(MODELS[0].id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [bubble, setBubble] = useState<string>("你好呀，我是小邻～");
  const [drag, setDrag] = useState<DragOffset>({ dx: 0, dy: 0 });
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const hostRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<ChatTurn[]>([]);
  const bubbleTimerRef = useRef<number | null>(null);
  const initStartedRef = useRef<string | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    baseDx: number;
    baseDy: number;
    moved: boolean;
  } | null>(null);

  // 恢复显隐与位置；只读一次 localStorage，避免 SSR 水合不一致。
  useEffect(() => {
    try {
      if (window.localStorage.getItem(HIDDEN_KEY) === "1") {
        setHidden(true);
      }
      const savedModel = window.localStorage.getItem(MODEL_KEY);
      if (savedModel && MODELS.some((item) => item.id === savedModel)) {
        setPetId(savedModel);
      }
      const saved = window.localStorage.getItem(DRAG_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as DragOffset;
        if (Number.isFinite(parsed.dx) && Number.isFinite(parsed.dy)) {
          setDrag(parsed);
        }
      }
    } catch {
      // 本地存储不可用时忽略，用默认位置
    }
  }, []);

  // 初始化 Live2D；失败则降级为 emoji 桌宠。切换角色（petId 变化）时销毁重建。
  // 注意：依赖只有 hidden 与 petId——mode 作为 state 不能进依赖，否则初始化成功触发
  // 重渲染时 cleanup 会把刚挂载的 pixi app 销毁掉。
  useEffect(() => {
    if (hidden || initStartedRef.current === petId) {
      return;
    }
    initStartedRef.current = petId;
    let disposed = false;
    let app: { destroy: (removeView?: boolean) => void } | null = null;

    const init = async () => {
      try {
        setMode("loading");
        await loadCubism2Core();
        if (disposed) {
          return;
        }

        const PIXI = await import("pixi.js");
        const { Live2DModel } = await import("pixi-live2d-display/cubism2");
        if (disposed) {
          return;
        }
        Live2DModel.registerTicker(PIXI.Ticker);

        const pixiApp = new PIXI.Application({
          autoDensity: true,
          backgroundAlpha: 0,
          height: CANVAS_H,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          width: CANVAS_W,
        });
        app = pixiApp as unknown as { destroy: (removeView?: boolean) => void };
        if (hostRef.current) {
          hostRef.current.replaceChildren(pixiApp.view as HTMLCanvasElement);
        }

        const url =
          MODELS.find((item) => item.id === petId)?.url ?? MODELS[0].url;
        const model = await Live2DModel.from(url, {
          autoInteract: true,
          autoUpdate: true,
        });
        if (disposed) {
          model.destroy();
          return;
        }
        const scale = Math.min(
          CANVAS_W / model.internalModel.width,
          MODEL_H / model.internalModel.height
        );
        model.scale.set(scale);
        model.anchor.set(0.5, 1);
        model.position.set(CANVAS_W / 2, CANVAS_H - 2);
        pixiApp.stage.addChild(model);
        modelRefHolder = model as typeof modelRefHolder;
        setMode("live2d");
      } catch (error) {
        console.warn("Live2D 桌宠初始化失败，降级为表情桌宠", error);
        if (!disposed) {
          setMode("emoji");
        }
      }
    };

    void init();

    return () => {
      disposed = true;
      initStartedRef.current = null;
      modelRefHolder = null;
      app?.destroy(true);
    };
  }, [hidden, petId]);

  // 气泡自动隐藏。
  const scheduleBubbleHide = useCallback(() => {
    if (bubbleTimerRef.current) {
      window.clearTimeout(bubbleTimerRef.current);
    }
    bubbleTimerRef.current = window.setTimeout(() => {
      setBubble("");
    }, BUBBLE_AUTOHIDE_MS);
  }, []);

  useEffect(
    () => () => {
      if (bubbleTimerRef.current) {
        window.clearTimeout(bubbleTimerRef.current);
      }
    },
    []
  );

  // 收到回复后随机换个表情。
  const changeExpression = useCallback(() => {
    try {
      modelRefHolder?.internalModel?.motionManager?.expressionManager?.setRandomExpression?.();
    } catch {
      // 表情切换失败不影响对话
    }
  }, []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) {
      return;
    }
    setSending(true);
    setBubble("…");
    scheduleBubbleHide();
    try {
      const response = await fetch(`${BASE_PATH}/api/pet/chat`, {
        body: JSON.stringify({
          history: historyRef.current.slice(-4),
          message: text,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await response.json()) as { reply?: string };
      const reply = data.reply || "（小邻没反应过来…）";
      setBubble(reply);
      historyRef.current = [
        ...historyRef.current.slice(-4),
        { role: "user", text },
        { role: "assistant", text: reply },
      ];
      changeExpression();
    } catch {
      setBubble("网络好像不太顺畅…");
    } finally {
      setSending(false);
      setInput("");
    }
  }, [changeExpression, input, scheduleBubbleHide, sending]);

  // 拖拽：按下超过 6px 视为拖动，拖动期间禁用画布指针事件避免误触发模型动作。
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      dragStateRef.current = {
        baseDx: drag.dx,
        baseDy: drag.dy,
        moved: false,
        startX: event.clientX,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [drag.dx, drag.dy]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = dragStateRef.current;
      if (!state) {
        return;
      }
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (!state.moved && Math.hypot(dx, dy) < 6) {
        return;
      }
      if (!state.moved) {
        state.moved = true;
        const canvas = hostRef.current?.querySelector("canvas");
        if (canvas) {
          canvas.style.pointerEvents = "none";
        }
      }
      setDrag({ dx: state.baseDx + dx, dy: state.baseDy + dy });
    },
    []
  );

  const onPointerUp = useCallback(() => {
    const state = dragStateRef.current;
    dragStateRef.current = null;
    const canvas = hostRef.current?.querySelector("canvas");
    if (canvas) {
      canvas.style.pointerEvents = "";
    }
    if (state?.moved) {
      setDrag((current) => {
        try {
          window.localStorage.setItem(DRAG_KEY, JSON.stringify(current));
        } catch {
          // 忽略存储失败
        }
        return current;
      });
    }
  }, []);

  const toggleHide = useCallback((next: boolean) => {
    setHidden(next);
    try {
      window.localStorage.setItem(HIDDEN_KEY, next ? "1" : "0");
    } catch {
      // 忽略存储失败
    }
  }, []);

  // 切换角色：持久化选择，气泡提示新角色打招呼。
  const switchPet = useCallback(
    (id: string) => {
      setMenuOpen(false);
      if (id === petId) {
        return;
      }
      setPetId(id);
      try {
        window.localStorage.setItem(MODEL_KEY, id);
      } catch {
        // 忽略存储失败
      }
      const next = MODELS.find((item) => item.id === id);
      setBubble(next ? `你好，我是${next.label.split(" ")[0]}～` : "");
      scheduleBubbleHide();
    },
    [petId, scheduleBubbleHide]
  );

  if (hidden) {
    return (
      <button
        className={cn(
          "fixed bottom-4 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full",
          "border border-border bg-card text-lg shadow-[var(--shadow-float)] transition-transform",
          "hover:scale-110 motion-safe:animate-bounce motion-reduce:animate-none"
        )}
        onClick={() => toggleHide(false)}
        title="叫回小邻"
        type="button"
      >
        🐾
      </button>
    );
  }

  // 位置换算成 right/bottom，并夹在视口内。
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const right = clamp(16 - drag.dx, 4, Math.max(vw - 220, 4));
  const bottom = clamp(16 - drag.dy, 4, Math.max(vh - 320, 4));

  return (
    <div
      className="pointer-events-none fixed z-40 flex flex-col items-center select-none"
      style={{ bottom, right }}
    >
      {bubble ? (
        <div
          className={cn(
            "pointer-events-auto mb-2 max-w-[240px] rounded-2xl rounded-br-sm",
            "border border-border bg-card px-3 py-2 text-xs leading-5 text-foreground",
            "shadow-[var(--shadow-float)]"
          )}
        >
          {bubble}
        </div>
      ) : null}

      <div
        className={cn(
          "group pointer-events-auto relative cursor-grab touch-none active:cursor-grabbing"
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ height: CANVAS_H, width: CANVAS_W }}
      >
        {/* hostRef 是 canvas 宿主：pixi 会用 replaceChildren 直接管它的子节点，
            因此内部绝不能放 React 子元素，否则水合对账时 removeChild 崩溃 */}
        <div
          className="absolute inset-0"
          ref={hostRef}
          style={{ height: CANVAS_H, width: CANVAS_W }}
        />
        {mode === "live2d" ? null : (
          <div className="pointer-events-none absolute inset-0 flex h-full w-full items-end justify-center">
            <span
              className={cn(
                "pb-2 text-6xl motion-safe:animate-bounce motion-reduce:animate-none"
              )}
            >
              {mode === "loading" ? "🐾" : "🐱"}
            </span>
          </div>
        )}
        {menuOpen ? (
          <div
            className={cn(
              "pointer-events-auto absolute -top-1 left-0 z-10 -translate-y-full",
              "overflow-hidden rounded-xl border border-border bg-card py-1 shadow-[var(--shadow-float)]"
            )}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {MODELS.map((item) => (
              <button
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground",
                  "hover:bg-muted",
                  item.id === petId && "bg-muted/60 font-medium"
                )}
                key={item.id}
                onClick={(event) => {
                  event.stopPropagation();
                  switchPet(item.id);
                }}
                type="button"
              >
                {item.label}
                {item.id === petId ? " ✓" : ""}
              </button>
            ))}
          </div>
        ) : null}
        <button
          aria-label="切换角色"
          className={cn(
            "absolute -top-1 left-14 hidden h-5 w-5 items-center justify-center rounded-full",
            "border border-border bg-card text-[10px] text-muted-foreground group-hover:flex"
          )}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          🎭
        </button>
        <button
          aria-label="隐藏桌宠"
          className={cn(
            "absolute -top-1 -right-1 hidden h-5 w-5 items-center justify-center rounded-full",
            "border border-border bg-card text-[10px] text-muted-foreground group-hover:flex"
          )}
          onClick={(event) => {
            event.stopPropagation();
            toggleHide(true);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          ×
        </button>
      </div>

      <input
        className={cn(
          "pointer-events-auto mt-1 w-[180px] rounded-full border border-border",
          "bg-card px-3 py-1.5 text-xs text-foreground outline-none",
          "placeholder:text-muted-foreground focus:border-ring"
        )}
        maxLength={200}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void sendMessage();
          }
        }}
        placeholder={sending ? "小邻思考中…" : "和小邻说点什么…"}
        value={input}
      />
    </div>
  );
}
