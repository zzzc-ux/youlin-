"use client";

import { useEffect, useRef } from "react";

/**
 * 花谷 WebGL 动效背景（迁移自 E:\youlin前端 的 "Fernhollow" 场景）。
 *
 * 实现：以全屏 iframe 加载 /valley/index.html（独立 webpack 运行时，避免与
 * 本项目 Next.js 的 webpackChunk_N_E 全局冲突），iframe 不接收任何点击；
 * 鼠标位置由父页面监听后 postMessage 转发进 iframe，实现"花随鼠标生长"。
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
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
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
