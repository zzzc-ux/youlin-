import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sql } from "drizzle-orm";
import { getClaimConversations, sendClaimMessage } from "../lib/campus/claims";
import { routeCampus, runCampusEngine } from "../lib/campus/engine";
import {
  createForumPost,
  deleteForumPost,
  getForumPostById,
  listForumPosts,
  listForumPostsByUser,
  searchForumPosts,
  updateForumPost,
} from "../lib/campus/forum";
import {
  countForumComments,
  createForumComment,
  listForumComments,
} from "../lib/campus/forum-comments";
import {
  createLostItem,
  listOpenItems,
  searchLostByText,
} from "../lib/campus/lost-found";
import { searchRepairs } from "../lib/campus/repairs";
import { createDatabase } from "../lib/db/client";
import type { CampusTraceStep } from "../lib/types";

test("多轮查询保留主题，七类校园问题可路由", () => {
  const cases = [
    ["6号楼停水吗", "notice"],
    ["6号楼312灯坏了", "repair"],
    ["校园卡余额", "card"],
    ["图书馆开放时间", "access"],
    ["这周有什么活动", "forum"],
    ["我丢了雨伞", "lost"],
    ["奖学金怎么申请", "qa"],
    ["停电公告", "notice"],
    ["宿舍报修空调坏了", "repair"],
    ["一卡通余额", "card"],
    ["体育馆几点关门", "access"],
    ["论坛社团招新", "forum"],
    ["捡到一把钥匙", "lost"],
    ["家庭经济困难认定", "qa"],
  ] as const;
  for (const [text, kind] of cases) {
    assert.equal(routeCampus(text, []).kind, kind, text);
  }
  const followup = routeCampus("那几点恢复", [
    { role: "user", text: "6号楼停水吗" },
  ]);
  assert.equal(followup.kind, "notice");
  assert.match(followup.query, /停水/);
});

test("登记、取消、并发确认及精确关闭只作用于目标记录", async () => {
  const original = process.cwd();
  const originalPostgres = process.env.POSTGRES_URL;
  const temp = await mkdtemp(path.join(os.tmpdir(), "campus-engine-"));
  await cp(
    path.join(original, "lib", "db", "migrations"),
    path.join(temp, "lib", "db", "migrations"),
    { recursive: true }
  );
  process.chdir(temp);
  delete process.env.POSTGRES_URL;
  const userId = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  const run = (text: string) =>
    runCampusEngine({ chatId, history: [], text, userId });
  try {
    const before = (await listOpenItems()).filter(
      (item) => item.userId === userId
    ).length;
    assert.equal((await run("我丢了一个紫色雨伞")).pending, true);
    assert.equal(
      (await listOpenItems()).filter((item) => item.userId === userId).length,
      before
    );
    const otherUser = await runCampusEngine({
      chatId,
      history: [],
      text: "确认",
      userId: crypto.randomUUID(),
    });
    assert.equal(otherUser.found, false);
    const confirmed = await Promise.all([run("确认"), run("确认")]);
    assert.equal(confirmed.filter((item) => item.found).length, 1);
    let own = (await listOpenItems()).filter((item) => item.userId === userId);
    assert.equal(own.length, 1);
    assert.equal(own[0].title, "紫色雨伞");
    assert.equal(own[0].category, "雨伞");
    await run("我丢了钥匙");
    await run("取消");
    assert.equal(
      (await listOpenItems()).filter((item) => item.userId === userId).length,
      1
    );
    const close = await run("雨伞已经找回了");
    assert.equal(close.pending, true);
    await run("确认");
    own = (await listOpenItems()).filter((item) => item.userId === userId);
    assert.equal(own.length, 0);
    assert.equal((await run("6号楼312灯坏了")).pending, true);
    assert.equal(searchRepairs("6号楼312").length, 0);
    assert.equal((await run("确认")).found, true);
    assert.equal(searchRepairs("6号楼312").length, 1);
    const notice = await run("6号楼停水吗");
    assert.equal(notice.kind, "notice");
    assert.equal(notice.found, true);
    assert.match(notice.answer, /来源/);

    const originalPosts = await listForumPosts();
    const postInput = {
      author: "student@example.test",
      chatId,
      history: [],
      userId,
    };
    const previewSteps: CampusTraceStep[] = [];
    const preview = await runCampusEngine({
      ...postInput,
      report: (step) => previewSteps.push(step),
      text: "我在图书馆丢了一把紫色雨伞，帮我发到论坛",
    });
    assert.equal(preview.pending, true);
    assert.match(preview.answer, /分类：求助/);
    assert.match(preview.answer, /内容：我在图书馆丢了一把紫色雨伞/);
    assert.equal((await listForumPosts()).length, originalPosts.length);
    assert.ok(
      previewSteps.some(
        (step) => step.state === "waiting" && step.label.includes("等待确认")
      )
    );
    assert.equal(
      previewSteps.some((step) => step.id === "execute"),
      false
    );
    const confirmationSteps: CampusTraceStep[] = [];
    const publishResults = await Promise.all([
      runCampusEngine({
        ...postInput,
        report: (step) => confirmationSteps.push(step),
        text: "确认发布",
      }),
      runCampusEngine({ ...postInput, text: "确认发布" }),
    ]);
    assert.equal(publishResults.filter((entry) => entry.found).length, 1);
    if (publishResults[0].found) {
      assert.deepEqual(
        confirmationSteps
          .filter((step) => step.id === "execute")
          .map((step) => step.state),
        ["running", "done"]
      );
    } else {
      assert.equal(
        confirmationSteps.some((step) => step.id === "execute"),
        false
      );
    }
    const posts = (await listForumPosts()).filter(
      (entry) => entry.userId === userId
    );
    assert.equal(posts.length, 1);
    assert.equal(
      publishResults.find((entry) => entry.found)?.forumPostId,
      posts[0].id
    );
    assert.equal((await getForumPostById(posts[0].id))?.body, posts[0].body);
    assert.equal(await getForumPostById(crypto.randomUUID()), null);
    assert.equal(posts[0].body, "我在图书馆丢了一把紫色雨伞");
    assert.equal(posts[0].author, "校园同学");
    assert.equal(posts[0].category, "求助");

    const draft = await runCampusEngine({
      ...postInput,
      text: "帮我在论坛发帖子",
    });
    assert.match(draft.answer, /请告诉我要发布的帖子内容/);
    const followup = await runCampusEngine({
      ...postInput,
      history: [
        { role: "user", text: "帮我在论坛发帖子" },
        { role: "assistant", text: draft.answer },
      ],
      text: "我捡到一串钥匙",
    });
    assert.equal(followup.pending, true);
    assert.match(followup.answer, /分类：招领/);
    await runCampusEngine({ ...postInput, text: "取消" });
    assert.equal(
      (await listForumPosts()).filter((entry) => entry.userId === userId)
        .length,
      1
    );
    const fromHistory = await runCampusEngine({
      ...postInput,
      history: [
        { role: "user", text: "我丢了黑色书包" },
        { role: "assistant", text: "已登记。" },
      ],
      text: "发到论坛",
    });
    assert.equal(fromHistory.pending, true);
    assert.match(fromHistory.answer, /内容：我丢了黑色书包/);
    await runCampusEngine({ ...postInput, text: "取消" });
    const direct = await runCampusEngine({
      ...postInput,
      text: "我丢了紫色雨伞，帮我发布",
    });
    assert.equal(direct.pending, true);
    assert.match(direct.answer, /内容：我丢了紫色雨伞/);
    assert.match(direct.answer, /发布者：校园同学/);
    await runCampusEngine({ ...postInput, text: "取消" });

    // 确认/取消指令允许首尾夹带引号和标点（实测：用户输入 确认发布” 曾导致指令失效、计划被顶替）
    const quoteInput = {
      author: "student@example.test",
      chatId: crypto.randomUUID(),
      history: [],
      userId,
    };
    const quotePreview = await runCampusEngine({
      ...quoteInput,
      text: "帮我在论坛发个闲置帖：转让一本九成新的高数教材",
    });
    assert.equal(quotePreview.pending, true);
    const quoted = await runCampusEngine({ ...quoteInput, text: "确认发布”" });
    assert.equal(quoted.found, true);
    assert.match(quoted.answer, /已发布到校园论坛/);
    const quoteCancelPreview = await runCampusEngine({
      ...quoteInput,
      text: "帮我在论坛发个闲置帖：转让一副羽毛球拍",
    });
    assert.equal(quoteCancelPreview.pending, true);
    const quotedCancel = await runCampusEngine({
      ...quoteInput,
      text: "“取消”",
    });
    assert.match(quotedCancel.answer, /已取消/);

    // 拾物者登记、发布、双方站内核对，最后由登记人确认归还。
    const foundPreview = await run(
      "我在图书馆捡到一张校园卡，手机号13800138000"
    );
    assert.equal(foundPreview.pending, true);
    const registered = await run("确认");
    assert.match(registered.answer, /已登记招领/);
    const foundItem = (await listOpenItems()).find(
      (item) => item.userId === userId && item.kind === "found"
    );
    assert.ok(foundItem);
    assert.doesNotMatch(foundItem.detail, /13800138000/);
    const linkedPreview = await runCampusEngine({
      ...postInput,
      history: [{ role: "assistant", text: registered.answer }],
      text: "发布这条失物到论坛",
    });
    assert.equal(linkedPreview.pending, true);
    assert.match(linkedPreview.answer, new RegExp(foundItem.id.slice(0, 8)));
    assert.doesNotMatch(linkedPreview.answer, /13800138000/);
    // 关联招领记录的帖子不走模型改写：标题/分类/正文均由登记信息确定性生成
    assert.match(linkedPreview.answer, /分类：招领/);
    assert.match(linkedPreview.answer, /标题：招领启事：校园卡/);
    assert.match(linkedPreview.answer, /内容：我在图书馆捡到一张校园卡/);
    assert.match(linkedPreview.answer, /招领记录编号/);
    const linkedPublished = await runCampusEngine({
      ...postInput,
      text: "确认发布",
    });
    assert.ok(linkedPublished.forumPostId);
    const linkedId = linkedPublished.forumPostId;
    const linkedPost = await getForumPostById(linkedId);
    assert.equal(linkedPost?.lostItemId, foundItem.id);
    assert.equal(linkedPost?.lostItemStatus, "open");
    assert.equal(linkedPost?.author, "校园同学");
    // 关联招领记录的帖子必须落在“招领”分类，否则论坛招领栏看不到
    assert.equal(linkedPost?.category, "招领");
    const duplicate = await runCampusEngine({
      ...postInput,
      text: `将编号 ${foundItem.id.slice(0, 8)} 的失物发到论坛`,
    });
    assert.equal(duplicate.forumPostId, linkedId);
    assert.equal(duplicate.pending, undefined);
    assert.equal((await searchLostByText("完全无关的词语")).length, 0);
    const claimant = crypto.randomUUID();
    const outsider = crypto.randomUUID();
    const outsiderClose = await runCampusEngine({
      chatId: crypto.randomUUID(),
      history: [],
      text: `编号 ${foundItem.id.slice(0, 8)} 已归还`,
      userId: outsider,
    });
    assert.equal(outsiderClose.pending, undefined);
    assert.equal((await getForumPostById(linkedId))?.lostItemStatus, "open");
    const claimantChat = crypto.randomUUID();
    const lostPreview = await runCampusEngine({
      chatId: claimantChat,
      history: [],
      text: "我丢了校园卡",
      userId: claimant,
    });
    assert.equal(lostPreview.pending, true);
    const match = await runCampusEngine({
      chatId: claimantChat,
      history: [],
      text: "确认",
      userId: claimant,
    });
    assert.match(match.answer, /可能相关/);
    assert.equal(match.forumPostId, linkedId);
    assert.equal(match.forumPostLabel, "查看相关帖子");
    await sendClaimMessage({
      body: "卡套是蓝色的，想核对一下。",
      postId: linkedId,
      userId: claimant,
    });
    const ownerInbox = await getClaimConversations(linkedId, userId);
    assert.equal(ownerInbox.isOwner, true);
    assert.equal(ownerInbox.threads.length, 1);
    const threadId = ownerInbox.threads[0].id;
    assert.equal(
      (await getClaimConversations(linkedId, outsider)).threads.length,
      0
    );
    await assert.rejects(
      () =>
        sendClaimMessage({
          body: "越权消息",
          postId: linkedId,
          threadId,
          userId: outsider,
        }),
      /无权限/
    );
    await sendClaimMessage({
      body: "请核对更多不公开的特征。",
      postId: linkedId,
      threadId,
      userId,
    });
    assert.equal(
      (await getClaimConversations(linkedId, claimant)).threads[0].messages
        .length,
      2
    );
    const closedPreview = await run(`编号 ${foundItem.id.slice(0, 8)} 已归还`);
    assert.equal(closedPreview.pending, true);
    assert.equal((await getForumPostById(linkedId))?.lostItemStatus, "open");
    await run("确认");
    assert.equal((await getForumPostById(linkedId))?.lostItemStatus, "closed");
    assert.equal(
      (await searchForumPosts("校园卡")).some((post) => post.id === linkedId),
      false
    );
    await assert.rejects(
      () =>
        sendClaimMessage({
          body: "还在吗",
          postId: linkedId,
          threadId,
          userId: claimant,
        }),
      /已关闭/
    );
    assert.equal(
      (await getClaimConversations(linkedId, claimant)).threads[0].messages
        .length,
      2
    );

    const manualPost = await createForumPost({
      author: "student@example.test",
      body: "联系电话 13800138000",
      category: "招领",
      eventTime: null,
      place: "联系 13800138000",
      title: "捡到雨伞 13800138000",
      userId,
    });
    assert.equal(manualPost.author, "校园同学");
    assert.doesNotMatch(
      `${manualPost.title}${manualPost.body}${manualPost.place}`,
      /13800138000/
    );

    const db = await createDatabase();
    await db.execute(
      sql`INSERT INTO "ForumPost" ("userId", "author", "category", "title", "body", "createdAt") SELECT ${userId}, '测试', '活动', '后续帖子', '后续内容', now() + interval '1 day' FROM generate_series(1, 81)`
    );
    assert.equal(
      (await listForumPosts()).some((post) => post.id === posts[0].id),
      false
    );
    assert.equal((await getForumPostById(posts[0].id))?.id, posts[0].id);
  } finally {
    const db = await createDatabase();
    await (
      db as unknown as { $client: { close: () => Promise<void> } }
    ).$client.close();
    (globalThis as Record<string, unknown>).chatbotDb = undefined;
    process.chdir(original);
    if (originalPostgres === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = originalPostgres;
    }
    await rm(temp, { force: true, recursive: true });
  }
});

test("我的帖子：筛选、编辑、删除及权限隔离", async () => {
  const original = process.cwd();
  const originalPostgres = process.env.POSTGRES_URL;
  const temp = await mkdtemp(path.join(os.tmpdir(), "campus-forum-manage-"));
  await cp(
    path.join(original, "lib", "db", "migrations"),
    path.join(temp, "lib", "db", "migrations"),
    { recursive: true }
  );
  process.chdir(temp);
  delete process.env.POSTGRES_URL;
  // 前一个用例已关闭进程内全局数据库实例，这里重置缓存以便在新目录重新打开
  (globalThis as Record<string, unknown>).chatbotDb = undefined;
  const owner = crypto.randomUUID();
  const other = crypto.randomUUID();
  try {
    const minePost = await createForumPost({
      author: "owner@example.test",
      body: "周六下午体育馆，自带球拍。",
      category: "活动",
      eventTime: "周六 15:00",
      place: "体育馆",
      title: "周末羽毛球活动",
      userId: owner,
    });
    const otherPost = await createForumPost({
      author: "other@example.test",
      body: "九成新机械键盘。",
      category: "闲置",
      eventTime: null,
      place: null,
      title: "出键盘",
      userId: other,
    });

    // 只看到自己的帖子
    const mineList = await listForumPostsByUser(owner);
    assert.equal(
      mineList.some((post) => post.id === minePost.id),
      true
    );
    assert.equal(
      mineList.some((post) => post.id === otherPost.id),
      false
    );
    const mineSearch = await searchForumPosts("键盘", undefined, owner);
    assert.equal(
      mineSearch.some((post) => post.id === otherPost.id),
      false
    );

    // 编辑：仅作者本人可改
    assert.equal(
      await updateForumPost({
        body: "篡改内容",
        category: "活动",
        eventTime: null,
        id: minePost.id,
        place: null,
        title: "被他人篡改",
        userId: other,
      }),
      null
    );
    const updated = await updateForumPost({
      body: "联系电话 13800138000",
      category: "招领",
      eventTime: null,
      id: minePost.id,
      place: "图书馆 13800138000",
      title: "捡到校园卡 13800138000",
      userId: owner,
    });
    assert.ok(updated);
    assert.equal(updated.author, "校园同学");
    assert.doesNotMatch(
      `${updated.title}${updated.body}${updated.place}`,
      /13800138000/
    );
    assert.equal(updated.category, "招领");

    // 删除：仅作者本人可删，且清理认领私信
    const item = await createLostItem({
      category: "钥匙",
      color: null,
      detail: "在食堂捡到一串钥匙。",
      kind: "found",
      place: "食堂",
      title: "钥匙",
      userId: owner,
    });
    const linked = await createForumPost({
      author: "owner@example.test",
      body: "在食堂捡到一串钥匙。",
      category: "招领",
      eventTime: null,
      lostItemId: item.id,
      place: "食堂",
      title: "捡到钥匙",
      userId: owner,
    });
    const claimant = crypto.randomUUID();
    await sendClaimMessage({
      body: "是我的钥匙。",
      postId: linked.id,
      userId: claimant,
    });
    assert.equal(await deleteForumPost(linked.id, other), false);
    assert.equal(await deleteForumPost(linked.id, owner), true);
    assert.equal(await getForumPostById(linked.id), null);
    await assert.rejects(() => getClaimConversations(linked.id, owner));

    // 论坛查询返回帖子入口（无模型环境走关键词兜底，命中种子活动帖）
    const forumQuery = await runCampusEngine({
      chatId: crypto.randomUUID(),
      history: [],
      text: "这周有什么活动",
      userId: owner,
    });
    assert.equal(forumQuery.kind, "forum");
    assert.equal(forumQuery.found, true);
    assert.ok(forumQuery.forumPostId);
    assert.ok((forumQuery.forumPosts ?? []).length > 0);
    assert.match(forumQuery.answer, /周五东区操场志愿服务/);
    const noHit = await runCampusEngine({
      chatId: crypto.randomUUID(),
      history: [],
      text: "有没有完全不存在的火星社团招新帖",
      userId: owner,
    });
    assert.equal(noHit.kind, "forum");
    assert.equal(noHit.found, false);
  } finally {
    const db = await createDatabase();
    await (
      db as unknown as { $client: { close: () => Promise<void> } }
    ).$client.close();
    process.chdir(original);
    if (originalPostgres === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = originalPostgres;
    }
    await rm(temp, { force: true, recursive: true });
  }
});

test("非预设类别可登记并脱敏，带联系方式的未识别请求被引导而非闲聊", async () => {
  const original = process.cwd();
  const originalPostgres = process.env.POSTGRES_URL;
  const temp = await mkdtemp(path.join(os.tmpdir(), "campus-engine-privacy-"));
  await cp(
    path.join(original, "lib", "db", "migrations"),
    path.join(temp, "lib", "db", "migrations"),
    { recursive: true }
  );
  process.chdir(temp);
  delete process.env.POSTGRES_URL;
  (globalThis as Record<string, unknown>).chatbotDb = undefined;
  const userId = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  const run = (text: string) =>
    runCampusEngine({ chatId, history: [], text, userId });
  try {
    // 复测场景：第一步“我丢失了一支水彩笔 我的电话号码为：13812345678”
    // 应直接生成登记计划（不再要求补充预设类别），且详情已脱敏
    const step1 = await run("我丢失了一支水彩笔 我的电话号码为：13812345678");
    assert.equal(step1.pending, true);
    assert.match(step1.answer, /登记寻物「水彩笔」/);
    const registered = await run("确认");
    assert.match(registered.answer, /已登记寻物/);
    const item = (await listOpenItems()).find(
      (entry) => entry.userId === userId
    );
    assert.ok(item);
    assert.equal(item.category, "水彩笔");
    assert.doesNotMatch(item.detail, /13812345678/);

    // 类别续接：预设类别之外的自造物品名（如“水彩笔”）应接住上一条失物请求
    const followup = routeCampus("水彩笔", [
      { role: "user", text: "我丢失了一支水彩笔" },
    ]);
    assert.equal(followup.kind, "lost");

    // 未识别为校园服务但贴出联系方式时，返回隐私引导并抑制通用模型接管
    const guidance = await runCampusEngine({
      chatId: crypto.randomUUID(),
      history: [],
      text: "我的私人电话是13912345678",
      userId,
    });
    assert.equal(guidance.suppressModel, true);
    assert.match(guidance.answer, /隐私/);
    assert.match(guidance.answer, /登记/);
  } finally {
    const db = await createDatabase();
    await (
      db as unknown as { $client: { close: () => Promise<void> } }
    ).$client.close();
    (globalThis as Record<string, unknown>).chatbotDb = undefined;
    process.chdir(original);
    if (originalPostgres === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = originalPostgres;
    }
    await rm(temp, { force: true, recursive: true });
  }
});

test("论坛评论：评论、两级回复、计数与级联删除", async () => {
  const original = process.cwd();
  const originalPostgres = process.env.POSTGRES_URL;
  const temp = await mkdtemp(path.join(os.tmpdir(), "campus-forum-comments-"));
  await cp(
    path.join(original, "lib", "db", "migrations"),
    path.join(temp, "lib", "db", "migrations"),
    { recursive: true }
  );
  process.chdir(temp);
  delete process.env.POSTGRES_URL;
  (globalThis as Record<string, unknown>).chatbotDb = undefined;
  const owner = crypto.randomUUID();
  const visitor = crypto.randomUUID();
  try {
    const post = await createForumPost({
      author: "owner@example.test",
      body: "周六下午体育馆，自带球拍。",
      category: "活动",
      eventTime: "周六 15:00",
      place: "体育馆",
      title: "周末羽毛球活动",
      userId: owner,
    });

    // 评论与不存在的帖子/跨帖 parent 校验
    const first = await createForumComment({
      author: "visitor@example.test",
      body: "还带人吗？",
      postId: post.id,
      userId: visitor,
    });
    assert.equal(first.parentId, null);
    await assert.rejects(
      () =>
        createForumComment({
          author: "v",
          body: "评论",
          postId: crypto.randomUUID(),
          userId: visitor,
        }),
      /帖子不存在/
    );
    const otherPost = await createForumPost({
      author: "owner@example.test",
      body: "九成新。",
      category: "闲置",
      eventTime: null,
      place: null,
      title: "出键盘",
      userId: owner,
    });
    await assert.rejects(
      () =>
        createForumComment({
          author: "v",
          body: "串帖回复",
          parentId: first.id,
          postId: otherPost.id,
          userId: visitor,
        }),
      /要回复的评论不存在/
    );

    // 两级回复：回复一条回复时挂到根评论下
    const reply = await createForumComment({
      author: "owner@example.test",
      body: "还带，直接来。",
      parentId: first.id,
      postId: post.id,
      userId: owner,
    });
    assert.equal(reply.parentId, first.id);
    const nested = await createForumComment({
      author: "visitor@example.test",
      body: "好的，谢谢！",
      parentId: reply.id,
      postId: post.id,
      userId: visitor,
    });
    assert.equal(nested.parentId, first.id);

    // 列表按时间升序，计数正确
    const comments = await listForumComments(post.id);
    assert.equal(comments.length, 3);
    assert.deepEqual(
      comments.map((comment) => comment.id),
      [first.id, reply.id, nested.id]
    );
    const counts = await countForumComments([post.id, otherPost.id]);
    assert.equal(counts.get(post.id), 3);
    assert.equal(counts.get(otherPost.id), undefined);

    // 删除帖子级联清理评论
    assert.equal(await deleteForumPost(post.id, owner), true);
    assert.equal((await listForumComments(post.id)).length, 0);
  } finally {
    const db = await createDatabase();
    await (
      db as unknown as { $client: { close: () => Promise<void> } }
    ).$client.close();
    (globalThis as Record<string, unknown>).chatbotDb = undefined;
    process.chdir(original);
    if (originalPostgres === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = originalPostgres;
    }
    await rm(temp, { force: true, recursive: true });
  }
});
