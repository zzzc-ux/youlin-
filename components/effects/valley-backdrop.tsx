"use client";

import { useEffect, useRef } from "react";

/**
 * 花谷 WebGL 动效背景（迁移自 E:\youlin前端 的 "Fernhollow" 场景）。
 *
 * 实现：以全屏 iframe 加载 /valley/index.html（独立 webpack 运行时，避免与
 * 本项目 Next.js 的 webpackChunk_N_E 全局冲突），iframe 不接收任何点击；
 * 鼠标位置与滚轮由父页面监听后 postMessage 转发进 iframe，
 * 实现"花随鼠标生长"与"滚动游走花谷"两个动效。
 *
 * 结构：canvas 背景层（无遮罩，完整呈现花谷原貌）。
 * 本组件只作为背景，不包含任何可交互元素，不影响对话页任何控件。
 */
export function ValleyBackdrop() {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "valley-pointer", x: e.clientX, y: e.clientY },
        window.location.origin,
      );
    };
    // 滚轮转发：花谷相机的"游走"进度由滚动驱动（原版为长页滚动）。
    // iframe pointer-events:none 收不到 wheel，这里捕获后转发进 iframe，
    // 由场景内 Lenis 换算为相机移动；passive + 不阻止默认，不影响页面正常滚动。
    // deltaY 取负：原版向下滚是倒退行进，这里统一为「向下 = 前进」。
    const onWheel = (e: WheelEvent) => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "valley-wheel", deltaY: -e.deltaY, deltaMode: e.deltaMode },
        window.location.origin,
      );
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("wheel", onWheel, {
      passive: true,
      capture: true,
    });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      <iframe
        aria-hidden
        className="h-full w-full border-0"
        ref={iframeRef}
        src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/valley/index.html`}
        tabIndex={-1}
        title="背景动效"
      />
    </div>
  );
}
