import { sql } from "drizzle-orm";
import { createDatabase } from "@/lib/db/client";
import { redactPublicText } from "./privacy";

export type LostItem = {
  id: string;
  userId: string;
  kind: "lost" | "found";
  title: string;
  detail: string;
  place: string | null;
  color: string | null;
  category: string | null;
  status: "open" | "closed";
  createdAt: string;
};

const SEED_OWNER = "00000000-0000-4000-8000-000000000001";

const readyByDb = new WeakMap<object, Promise<void>>();

async function rowsOf<T = LostItem>(result: unknown): Promise<T[]> {
  const rows = (result as { rows?: T[] }).rows ?? [];
  return rows;
}

export async function ensureLostFoundStore() {
  const db = await createDatabase();
  let ready = readyByDb.get(db);
  if (!ready) {
    ready = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "LostItem" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "userId" uuid NOT NULL,
          "kind" varchar(16) NOT NULL,
          "title" varchar(80) NOT NULL,
          "detail" text NOT NULL,
          "place" varchar(80),
          "color" varchar(40),
          "category" varchar(40),
          "status" varchar(16) NOT NULL DEFAULT 'open',
          "createdAt" timestamp NOT NULL DEFAULT now()
        )
      `);
      const existing = await rowsOf(
        await db.execute(sql`SELECT "id" FROM "LostItem" LIMIT 1`)
      );
      if (existing.length > 0) {
        return;
      }
      await db.execute(sql`
        INSERT INTO "LostItem" ("userId", "kind", "title", "detail", "place", "color", "category", "status")
        VALUES
          (${SEED_OWNER}, 'found', '校园卡', '蓝色卡套，卡面姓名模糊，已交到图书馆服务台。', '图书馆', '蓝色', '校园卡', 'open'),
          (${SEED_OWNER}, 'found', '黑色书包', '双肩包，内侧有算法课本，暂存在东区食堂失物处。', '食堂', '黑色', '书包', 'open'),
          (${SEED_OWNER}, 'found', '白色水杯', '保温杯，杯身有绿色挂绳，教学楼 A 一层大厅。', '教学楼', '白色', '水杯', 'open')
      `);
    })().catch((error) => {
      readyByDb.delete(db);
      throw error;
    });
    readyByDb.set(db, ready);
  }
  return ready;
}

export async function searchLostByText(text: string): Promise<LostItem[]> {
  const items = await listOpenItems();
  const ranked = items
    .map((item) => {
      const blob = [item.title, item.detail, item.place, item.color, item.category]
        .filter(Boolean)
        .join(" ");
      let score = 0;
      if (item.category && text.includes(item.category)) {
        score += 5;
      }
      if (item.color && text.includes(item.color)) {
        score += 2;
      }
      if (item.place && text.includes(item.place)) {
        score += 2;
      }
      if (blob && text.includes(item.title)) {
        score += 2;
      }
      return { item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked.map((item) => item.item).slice(0, 5);
}

export async function listOpenItems(): Promise<LostItem[]> {
  await ensureLostFoundStore();
  const db = await createDatabase();
  return rowsOf(
    await db.execute(sql`
      SELECT "id", "userId", "kind", "title", "detail", "place", "color", "category", "status", "createdAt"
      FROM "LostItem"
      WHERE "status" = 'open'
      ORDER BY "createdAt" DESC
      LIMIT 40
    `)
  );
}

export async function listOwnOpenItems(userId: string): Promise<LostItem[]> {
  await ensureLostFoundStore();
  const db = await createDatabase();
  return rowsOf(await db.execute(sql`
    SELECT "id", "userId", "kind", "title", "detail", "place", "color", "category", "status", "createdAt"
    FROM "LostItem" WHERE "userId" = ${userId} AND "status" = 'open'
    ORDER BY "createdAt" DESC
  `));
}

export async function findComplementaryItems(item: LostItem): Promise<LostItem[]> {
  if (!item.category) return [];
  await ensureLostFoundStore();
  const db = await createDatabase();
  return rowsOf(await db.execute(sql`
    SELECT "id", "userId", "kind", "title", "detail", "place", "color", "category", "status", "createdAt"
    FROM "LostItem" WHERE "status" = 'open' AND "category" = ${item.category}
      AND "kind" <> ${item.kind} AND "userId" <> ${item.userId}
    ORDER BY (CASE WHEN "color" IS NOT NULL AND "color" = ${item.color} THEN 1 ELSE 0 END
            + CASE WHEN "place" IS NOT NULL AND "place" = ${item.place} THEN 1 ELSE 0 END) DESC, "createdAt" DESC
    LIMIT 3
  `));
}

export async function createLostItem(input: {
  userId: string;
  kind: "lost" | "found";
  title: string;
  detail: string;
  place: string | null;
  color: string | null;
  category: string | null;
}): Promise<LostItem> {
  await ensureLostFoundStore();
  const db = await createDatabase();
  const created = await rowsOf(
    await db.execute(sql`
      INSERT INTO "LostItem" ("userId", "kind", "title", "detail", "place", "color", "category", "status")
      VALUES (
        ${input.userId},
        ${input.kind},
        ${input.title},
        ${redactPublicText(input.detail)},
        ${input.place},
        ${input.color},
        ${input.category},
        'open'
      )
      RETURNING "id", "userId", "kind", "title", "detail", "place", "color", "category", "status", "createdAt"
    `)
  );
  const item = created[0];
  if (!item) {
    throw new Error("失物记录没有写入成功");
  }
  return item;
}

export async function closeOwnItem(
  userId: string,
  category: string | null,
  itemId?: string
): Promise<LostItem | null> {
  await ensureLostFoundStore();
  const db = await createDatabase();
  const openItems = await rowsOf(
    await db.execute(sql`
      SELECT "id", "userId", "kind", "title", "detail", "place", "color", "category", "status", "createdAt"
      FROM "LostItem"
      WHERE "userId" = ${userId} AND "status" = 'open'
      ORDER BY "createdAt" DESC
    `)
  );
  const target = itemId
    ? openItems.find((item) => item.id === itemId)
    : openItems.find((item) => category && item.category === category) ?? openItems[0];
  if (!target) {
    return null;
  }
  const updated = await rowsOf(await db.execute(sql`
    UPDATE "LostItem" SET "status" = 'closed'
    WHERE "id" = ${target.id} AND "userId" = ${userId} AND "status" = 'open'
    RETURNING "id", "userId", "kind", "title", "detail", "place", "color", "category", "status", "createdAt"
  `));
  const closedItem = updated[0];
  if (!closedItem) {
    return null;
  }
  await syncForumPostsOnClose(db, userId, closedItem);
  return closedItem;
}

/**
 * 关闭失物记录后同步论坛关联帖子，避免"对话里说已找回、论坛帖子仍是寻找中"：
 * 1. 同一物品重复登记：同用户名下「类别+标题」相同的其它开放记录一并关闭，
 *    这样绑定在这些重复记录上的帖子会自动显示已解决（帖子状态由关联记录派生）。
 * 2. 帖子正文提及了本记录的八位编号、但关联记录不对（或未关联）时，
 *    把帖子重新关联到本记录（一条记录只能绑定一个帖子，冲突时跳过）。
 */
async function syncForumPostsOnClose(
  db: Awaited<ReturnType<typeof createDatabase>>,
  userId: string,
  closedItem: LostItem
): Promise<void> {
  const shortId = closedItem.id.slice(0, 8);
  try {
    // 联动 1：归并同一物品的重复登记记录
    await db.execute(sql`
      UPDATE "LostItem" SET "status" = 'closed'
      WHERE "userId" = ${userId} AND "status" = 'open' AND "id" <> ${closedItem.id}
        AND "category" = ${closedItem.category} AND "title" = ${closedItem.title}
    `);
    // 联动 2：正文/标题提及本记录编号、但未绑定到本记录的帖子 → 重新关联
    const posts = await rowsOf<{ id: string; lostItemId: string | null }>(
      await db.execute(sql`
        SELECT "id", "lostItemId" FROM "ForumPost"
        WHERE "userId" = ${userId}
          AND ("body" LIKE ${`%${shortId}%`} OR "title" LIKE ${`%${shortId}%`})
      `)
    );
    if (posts.length === 0) {
      return;
    }
    const alreadyBound = posts.some((post) => post.lostItemId === closedItem.id);
    if (alreadyBound) {
      return;
    }
    const unbound = posts.find((post) => post.lostItemId == null);
    if (unbound) {
      await db.execute(sql`
        UPDATE "ForumPost" SET "lostItemId" = ${closedItem.id}
        WHERE "id" = ${unbound.id}
      `);
    } else {
      // 所有提及编号的帖子都已绑定其它记录（多为重复登记），关闭未关闭的那条
      const otherIds = posts
        .map((post) => post.lostItemId)
        .filter((id): id is string => Boolean(id) && id !== closedItem.id);
      if (otherIds.length > 0) {
        await db.execute(sql`
          UPDATE "LostItem" SET "status" = 'closed'
          WHERE "userId" = ${userId} AND "status" = 'open'
            AND "id" IN ${sql`( ${sql.join(otherIds.map((id) => sql`${id}::uuid`), sql`, `)} )`}
        `);
      }
    }
  } catch {
    // 联动失败不影响关闭记录本身（如唯一索引冲突、表尚未创建等）
  }
}
