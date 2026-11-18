"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { bulletinCover } from "@/lib/campus/bulletin-covers";
import {
  type Bulletin,
  type BulletinCategory,
  bulletinStamp,
  listBulletinGroups,
} from "@/lib/campus/bulletins";
import { cn } from "@/lib/utils";

/** 三格共享一个节拍。5.5s 是读完一句中文标题的余量，不是刷广告的 3s */
const ROTATE_MS = 5500;

const CATEGORY_TONE: Record<BulletinCategory, string> = {
  快报: "var(--bulletin-brief)",
  思政: "var(--primary)",
  热点: "var(--bulletin-hot)",
};

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * 封面图地址归一。
 *
 * - 站内路径（现在是 AI 生成的配图，放在 public/bulletins/ai）直接交给 <img>，
 *   demo 模式开了 basePath 时要带上前缀，否则静态文件 404。
 * - 外部地址统一走站内代理：人民网是 http，且域名不在 next/image 白名单里。
 */
function coverSrc(url: string): string {
  if (url.startsWith("/")) {
    return `${BASE_PATH}${url}`;
  }
  return `${BASE_PATH}/api/img-proxy?url=${encodeURIComponent(url)}`;
}

/** 用路径前缀标记来源，省得给表加字段。AI 配图必须让读者看得出来不是现场照片 */
function isAiCover(url?: string): boolean {
  return (url ?? "").startsWith("/bulletins/ai/");
}

function BulletinCard({ item }: { item: Bulletin }) {
  const cover = bulletinCover(item);
  const body = (
    <>
      <div className="flex items-baseline gap-1.5 text-[11.5px] leading-[1.35]">
        <i
          aria-hidden="true"
          className="size-[5px] shrink-0 translate-y-[-1px] rounded-full"
          style={{ backgroundColor: CATEGORY_TONE[item.category] }}
        />
        <em className="font-medium not-italic text-foreground/85">
          {item.category}
        </em>
        <span className="ml-auto font-mono text-[10.5px] tracking-[0.02em] text-foreground/45">
          {bulletinStamp(item)}
        </span>
      </div>

      {cover ? (
        // 有封面就把图铺满卡片当背景，标题压在图上；渐变保证浅色图上字也读得清
        <div className="relative mt-1.5 aspect-[12/5] w-full overflow-hidden rounded-[4px]">
          {/* biome-ignore lint/performance/noImgElement: 封面域名来自实时抓取，只能经站内代理转发 */}
          <img
            alt=""
            className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
            loading="lazy"
            referrerPolicy="no-referrer"
            src={coverSrc(cover)}
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
          {isAiCover(cover) ? (
            <span className="absolute top-1 right-1 rounded-[3px] bg-black/40 px-1 py-[1px] text-[9px] text-white/70 leading-[1.4] backdrop-blur-[2px]">
              AI 配图
            </span>
          ) : null}
          <div className="relative flex h-full flex-col justify-end gap-1 p-2">
            <h3 className="line-clamp-3 text-[13px] font-medium leading-[1.45] text-white/95">
              {item.title}
            </h3>
            <p className="truncate font-mono text-[10px] text-white/60">
              {item.source}
            </p>
          </div>
        </div>
      ) : (
        // 无图版式：不留灰白占位框，直接排成纯文字条，与有图版共用图片高度
        <div
          className="mt-1.5 flex aspect-[12/5] w-full flex-col justify-center gap-3 overflow-hidden rounded-[4px] bg-[var(--bulletin-surface)] py-2 pr-2 pl-2.5"
          style={{ borderLeft: `2px solid ${CATEGORY_TONE[item.category]}` }}
        >
          <p className="line-clamp-2 text-[13px] font-medium leading-[1.45] text-foreground/85">
            {item.title}
          </p>
          <p className="truncate font-mono text-[10px] text-foreground/40">
            {item.source}
          </p>
        </div>
      )}
    </>
  );

  if (item.href) {
    // 外部新闻用原生 a 并开新窗，站内链接才走 Link
    if (/^https?:\/\//.test(item.href)) {
      return (
        <a
          className="group block rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          href={item.href}
          rel="noreferrer noopener"
          target="_blank"
        >
          {body}
        </a>
      );
    }
    return (
      <Link
        className="group block rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        href={item.href}
      >
        {body}
      </Link>
    );
  }

  return <div className="group">{body}</div>;
}

/**
 * 节拍条的一节。做成按钮而不是装饰性 span，是为了能点着跳转。
 * 外壳撑到 h-4 给手指留点击面积，视觉上仍只是一条 2px 的横线。
 */
function BeatButton({
  active,
  position,
  onSelect,
}: {
  active: boolean;
  onSelect: (position: number) => void;
  position: number;
}) {
  const handleClick = useCallback(
    () => onSelect(position),
    [onSelect, position]
  );

  return (
    <button
      aria-current={active ? "true" : undefined}
      aria-label={`第 ${position + 1} 组要闻`}
      className="group flex h-4 cursor-pointer items-center px-0.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
      onClick={handleClick}
      type="button"
    >
      <span
        className={cn(
          "h-[2px] rounded-[1px] transition-all duration-150",
          active
            ? "w-[18px] bg-primary"
            : "w-3 bg-foreground/20 group-hover:bg-foreground/40"
        )}
      />
    </button>
  );
}

export function BulletinBoard() {
  // 首屏直接给种子数据，接口回来再换成「种子 + 已审核新闻」
  const [groups, setGroups] = useState<Bulletin[][]>(() =>
    listBulletinGroups(3)
  );
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  // 移动端靠手指横滑，不自动翻页。布局用 CSS 切，这里只管定时器要不要跑
  const [wideScreen, setWideScreen] = useState(true);
  const boardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE_PATH}/api/forum/bulletins`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { groups?: Bulletin[][] } | null) => {
        if (
          !cancelled &&
          Array.isArray(data?.groups) &&
          data.groups.length > 0
        ) {
          setGroups(data.groups);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const wide = window.matchMedia("(min-width: 768px)");
    setReduceMotion(motion.matches);
    setWideScreen(wide.matches);

    const onMotion = (event: MediaQueryListEvent) =>
      setReduceMotion(event.matches);
    const onWide = (event: MediaQueryListEvent) => setWideScreen(event.matches);
    motion.addEventListener("change", onMotion);
    wide.addEventListener("change", onWide);
    return () => {
      motion.removeEventListener("change", onMotion);
      wide.removeEventListener("change", onWide);
    };
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // 鼠标停在某条上就是「我要看这条」，整组停住
  useEffect(() => {
    const node = boardRef.current;
    if (!node) {
      return;
    }
    const enter = () => setHovering(true);
    const leave = () => setHovering(false);
    node.addEventListener("mouseenter", enter);
    node.addEventListener("mouseleave", leave);
    return () => {
      node.removeEventListener("mouseenter", enter);
      node.removeEventListener("mouseleave", leave);
    };
  }, []);

  const rotating =
    wideScreen && !reduceMotion && !paused && !hovering && pageVisible;

  useEffect(() => {
    if (!rotating || groups.length < 2) {
      return;
    }
    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % groups.length);
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [rotating, groups.length]);

  const togglePaused = useCallback(() => setPaused((value) => !value), []);

  // 手动点某一节拍就是「我要看这一组」：跳过去并停住，否则 5.5s 后又被自动翻走
  const selectGroup = useCallback((position: number) => {
    setIndex(position);
    setPaused(true);
  }, []);

  // 接口回来后组数可能变少，越界的 index 会让高亮落空，兜回第一组
  useEffect(() => {
    setIndex((value) => (value >= groups.length ? 0 : value));
  }, [groups.length]);

  if (groups.length === 0) {
    return null;
  }

  const visibleGroup = groups[Math.min(index, groups.length - 1)];

  return (
    <section
      aria-label="思政、热点与校园快报"
      className="mt-5 mb-1"
      ref={boardRef}
    >
      <div
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:grid md:grid-cols-3 md:overflow-visible md:pb-0"
        key={index}
      >
        {visibleGroup.map((item) => (
          <article
            className="w-[76vw] max-w-[300px] shrink-0 snap-start motion-safe:animate-in motion-safe:fade-in motion-safe:duration-[220ms] md:w-auto md:max-w-none"
            key={item.id}
          >
            <BulletinCard item={item} />
          </article>
        ))}
      </div>

      <div className="mt-2.5 flex items-center gap-2.5">
        <div className="flex items-center gap-0.5">
          {groups.map((group, position) => (
            <BeatButton
              active={position === index}
              key={group[0]?.id ?? position}
              onSelect={selectGroup}
              position={position}
            />
          ))}
        </div>
        {reduceMotion ? (
          <span className="text-[10.5px] text-foreground/30">
            已停止自动翻页
          </span>
        ) : (
          <button
            className="text-[10.5px] text-foreground/40 transition-colors duration-150 hover:text-foreground/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onClick={togglePaused}
            type="button"
          >
            {paused ? "继续翻页" : "暂停翻页"}
          </button>
        )}
      </div>
    </section>
  );
}
