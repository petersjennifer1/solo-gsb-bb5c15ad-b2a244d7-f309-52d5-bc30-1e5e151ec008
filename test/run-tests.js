'use strict';

// 临时测试脚本：验证章节起页、拼版计划与生成 PDF 的结构。用完即删。
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { buildPlan, buildBookSequence, parseChapterStarts, createImposedPdf } = require('../server.js');

async function makeSource(n) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= n; i++) {
    const page = doc.addPage([595.28, 841.89]); // A4 竖向
    page.drawText(`PAGE ${i}`, {
      x: 180,
      y: 400,
      size: 48,
      font,
      color: rgb(0, 0, 0),
    });
    page.drawText(`top-of-page-${i}`, {
      x: 120,
      y: 760,
      size: 14,
      font,
      color: rgb(0.8, 0.1, 0.1),
    });
  }
  return doc;
}

function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
}

function seqPages(plan) {
  return plan.sequence
    .filter((s) => s.type === 'content')
    .map((s) => s.sourcePage);
}

function seqTypes(plan) {
  return plan.sequence.map((s) => (s.type === 'content' ? s.sourcePage : s.type));
}

function allSlots(plan) {
  const out = [];
  for (const sig of plan.signatures) {
    for (const sheet of sig.sheets) {
      out.push(sheet.front.left, sheet.front.right, sheet.back.left, sheet.back.right);
    }
  }
  return out;
}

function expectThrow(label, fn) {
  try {
    fn();
    check(label, false);
  } catch {
    check(label, true);
  }
}

async function run() {
  // ---- 章节起页：6 页指定 2,3 -> 1、章节空白、2、章节空白、3、4、5、6 ----
  const seq = buildBookSequence(6, [2, 3]);
  check(
    '书序 6页起页2,3 = 1/空/2/空/3/4/5/6',
    JSON.stringify(seq.map((s) => (s.type === 'content' ? s.sourcePage : '空'))) ===
      JSON.stringify([1, '空', 2, '空', 3, 4, 5, 6])
  );

  let plan = buildPlan(6, 2, [2, 3]); // 8 页/帖：书序恰好 8 页，末帖不补白
  check('6页起页2,3: 1帖', plan.signatureCount === 1);
  check('章节空白2、末帖补白0', plan.chapterBlankCount === 2 && plan.padBlankCount === 0);
  check('书序总页数8', plan.bookPageCount === 8);

  // 书序位置 1..8 = P1,空A,P2,空B,P3,P4,P5,P6；套帖后：
  // 纸1 正 [P6,P1] 反 [空A,P5]；纸2 正 [P4,P2] 反 [空B,P3]
  const s1 = plan.signatures[0].sheets;
  check('帖1纸1 正 6/1', s1[0].front.left.sourcePage === 6 && s1[0].front.right.sourcePage === 1);
  check('帖1纸1 反 章节空白/5', s1[0].back.left.type === 'chapter-blank' && s1[0].back.right.sourcePage === 5);
  check('帖1纸2 正 4/2', s1[1].front.left.sourcePage === 4 && s1[1].front.right.sourcePage === 2);
  check('帖1纸2 反 章节空白/3', s1[1].back.left.type === 'chapter-blank' && s1[1].back.right.sourcePage === 3);

  // 起页已在奇位时不插空：6 页指定 3 -> 1,2,3,4,5,6 + 2 末帖补白
  plan = buildPlan(6, 1, [3]);
  check('6页起页3: 无章节空白', plan.chapterBlankCount === 0);
  check('6页起页3: 2帖、末帖补白2', plan.signatureCount === 2 && plan.padBlankCount === 2);
  check(
    '6页起页3: 书序与原页一致后补白',
    JSON.stringify(seqTypes(plan)) === JSON.stringify([1, 2, 3, 4, 5, 6, 'pad-blank', 'pad-blank'])
  );

  // 连续插空影响后续判断：5 页指定 2,4
  // pos: 1(P1), 插空, P2(pos3), P3(pos4), P4 前 pos5 奇 -> 不插空, P4(pos5), P5(pos6)
  plan = buildPlan(5, 2, [2, 4]);
  check(
    '5页起页2,4 书序 = 1/空/2/3/4/5 + 2补白',
    JSON.stringify(seqTypes(plan)) ===
      JSON.stringify([1, 'chapter-blank', 2, 3, 4, 5, 'pad-blank', 'pad-blank'])
  );

  // 中文逗号与空白
  check('parseChapterStarts 支持中文逗号/空白', JSON.stringify(parseChapterStarts(' 2， 4 ', 5)) === '[2,4]');
  check('parseChapterStarts 留空 -> []', parseChapterStarts('   ', 5).length === 0);
  check('parseChapterStarts 1 合法', parseChapterStarts('1', 5)[0] === 1);
  expectThrow('parseChapterStarts 非整数报错', () => parseChapterStarts('2,a', 5));
  expectThrow('parseChapterStarts 小数报错', () => parseChapterStarts('2.5', 5));
  expectThrow('parseChapterStarts 0 越界报错', () => parseChapterStarts('0', 5));
  expectThrow('parseChapterStarts 越界报错', () => parseChapterStarts('6', 5));
  expectThrow('parseChapterStarts 负数报错', () => parseChapterStarts('-1', 5));
  expectThrow('parseChapterStarts 重复报错', () => parseChapterStarts('2,2', 5));
  expectThrow('parseChapterStarts 空项报错', () => parseChapterStarts('2,,3', 5));

  // ---- 不指定章节起页：保持原有行为 ----
  plan = buildPlan(9, 1);
  check('4页帖: 共3帖', plan.signatureCount === 3);
  check('4页帖: 补齐后12页, 末帖补白3', plan.totalPadded === 12 && plan.padBlankCount === 3);
  check('无章节空白', plan.chapterBlankCount === 0);
  // 第3帖（页9,10,11,12 中后3补白）: 正 补白/P9, 反 补白/补白
  const p3 = plan.signatures[2].sheets[0];
  check('末帖正面 补白/P9', p3.front.left.type === 'pad-blank' && p3.front.right.sourcePage === 9);
  check('末帖反面 补白/补白', p3.back.left.type === 'pad-blank' && p3.back.right.type === 'pad-blank');

  plan = buildPlan(10, 2);
  check('8页帖: 共2帖', plan.signatureCount === 2);
  check('8页帖: 补齐16页, 末帖补白6', plan.totalPadded === 16 && plan.padBlankCount === 6);
  const t1 = plan.signatures[0].sheets;
  check('帖1纸1 正 8/1', t1[0].front.left.sourcePage === 8 && t1[0].front.right.sourcePage === 1);
  check('帖1纸1 反 2/7', t1[0].back.left.sourcePage === 2 && t1[0].back.right.sourcePage === 7);
  check('帖1纸2 正 6/3', t1[1].front.left.sourcePage === 6 && t1[1].front.right.sourcePage === 3);
  check('帖1纸2 反 4/5', t1[1].back.left.sourcePage === 4 && t1[1].back.right.sourcePage === 5);

  // 恰好整帖不补白
  plan = buildPlan(8, 2);
  check('整帖不补白', plan.padBlankCount === 0 && plan.signatureCount === 1);
  plan = buildPlan(4, 1);
  check('4页1帖不补白', plan.padBlankCount === 0);

  // ---- 完整性：原页不得遗漏或重复（计划书序 + 帖槽位两处映射一致）----
  for (const [n, sps, starts] of [
    [6, 2, [2, 3]],
    [5, 1, [2, 4]],
    [13, 2, [1, 5, 9, 13]],
    [10, 1, [2, 3, 6, 9]],
    [17, 2, [3]],
  ]) {
    const p = buildPlan(n, sps, starts);
    const inSeq = seqPages(p);
    const slots = allSlots(p);
    const inSlots = slots
      .filter((s) => s.type === 'content')
      .map((s) => s.sourcePage);
    const key = (s) => (s.type === 'content' ? `c${s.sourcePage}` : s.type);
    check(
      `原页不遗漏不重复 (n=${n},起页=${starts.join('|')}) 书序`,
      JSON.stringify(inSeq) === JSON.stringify(Array.from({ length: n }, (_, i) => i + 1))
    );
    check(
      `帖槽位与书序槽位为同一映射 (n=${n})`,
      JSON.stringify(slots.map(key).sort()) === JSON.stringify(p.sequence.map(key).sort())
    );
    check(`帖槽位原页同样完整 (n=${n})`, JSON.stringify(inSlots.sort((a, b) => a - b)) === JSON.stringify(inSeq));
  }

  // ---- 生成 PDF 结构校验 ----
  const src = await makeSource(9);
  const out1 = await createImposedPdf(src, buildPlan(9, 1));
  check('9页4页帖 -> 3张纸6个拼版面', out1.getPageCount() === 6);
  for (let i = 0; i < out1.getPageCount(); i++) {
    const { width, height } = out1.getPage(i).getSize();
    check(`面${i + 1} 为A4横向(${width.toFixed(0)}x${height.toFixed(0)})`,
      Math.abs(width - 841.89) < 1 && Math.abs(height - 595.28) < 1);
  }

  const src2 = await makeSource(10);
  const out2 = await createImposedPdf(src2, buildPlan(10, 2));
  check('10页8页帖 -> 4张纸8个拼版面', out2.getPageCount() === 8);

  // 章节起页拼版：6 页 + 2 个章节空白 = 8 页，1 张套帖、4 个拼版面
  const src4 = await makeSource(6);
  const out4 = await createImposedPdf(src4, buildPlan(6, 2, [2, 3]));
  check('6页起页2,3 8页帖 -> 2张纸4个拼版面', out4.getPageCount() === 4);

  // ---- 旋转页 / 空白页（无 Contents）不报错 ----
  const src3 = await PDFDocument.create();
  const f3 = await src3.embedFont(StandardFonts.HelveticaBold);
  const pr = src3.addPage([841.89, 595.28]); // 横向页 + /Rotate 90 -> 竖向阅读
  pr.drawText('ROTATED PAGE TOP', { x: 60, y: 540, size: 20, font: f3 });
  pr.setRotation(degrees(90));
  src3.addPage([595.28, 841.89]); // 第2页完全空白，无 Contents
  const pn = src3.addPage([595.28, 841.89]);
  pn.drawText('PAGE 3', { x: 200, y: 400, size: 40, font: f3 });
  const out3 = await createImposedPdf(src3, buildPlan(3, 1));
  check('旋转+空白输入 -> 1张纸2面', out3.getPageCount() === 2);

  // 内容流里应出现旋转矩阵（0 1 -1 0 ... 表示逆时针 90°）
  const firstSide = out3.getPage(0);
  const ctx = out3.context;
  const contentRefs = firstSide.node.Contents().asArray();
  const decoded = contentRefs
    .map((ref) => {
      const obj = ctx.lookup(ref);
      // Contents 数组里可能还嵌套了 PDFArray（pdf-lib 追加分页内容时的行为）
      if (obj.asArray) {
        return obj
          .asArray()
          .map((r) => new TextDecoder().decode(ctx.lookup(r).getUnencodedContents()))
          .join('\n');
      }
      return new TextDecoder().decode(obj.getUnencodedContents());
    })
    .join('\n');
  check('第1面包含 90° 旋转矩阵', /-?\d+(?:\.\d+)?(?:e-?\d+)?\s+1(?:\.0+)?\s+-1(?:\.0+)?\s+-?\d+(?:\.\d+)?(?:e-?\d+)?\s+/.test(decoded));

  await require('fs').promises.writeFile('/workspace/test-out-9p-4s.pdf', await out1.save());
  await require('fs').promises.writeFile('/workspace/test-out-10p-8s.pdf', await out2.save());
  await require('fs').promises.writeFile('/workspace/test-out-chapter.pdf', await out4.save());
  await require('fs').promises.writeFile('/workspace/test-out-rotated.pdf', await out3.save());
  console.log('样例 PDF 已写出，供人工查看');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
