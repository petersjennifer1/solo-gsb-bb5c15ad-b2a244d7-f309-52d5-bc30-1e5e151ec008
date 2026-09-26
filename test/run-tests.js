'use strict';

// 临时测试脚本：验证拼版计划与生成 PDF 的结构。用完即删。
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { buildPlan, createImposedPdf } = require('../server.js');

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

async function run() {
  // ---- 计划校验：4页 / 帖 ----
  let plan = buildPlan(9, 1);
  check('4页帖: 共3帖', plan.signatureCount === 3);
  check('4页帖: 补齐后12页, 空白3', plan.totalPadded === 12 && plan.blankCount === 3);
  // 第3帖（页9,10,11,12 中后3空白）: 正 12/9, 反 10/11
  const s3 = plan.signatures[2].sheets[0];
  check('末帖正面 空白/P9', s3.front.left === null && s3.front.right === 9);
  check('末帖反面 空白/空白（P10、P11为空白）', s3.back.left === null && s3.back.right === null);

  // ---- 计划校验：8页 / 帖 ----
  plan = buildPlan(10, 2);
  check('8页帖: 共2帖', plan.signatureCount === 2);
  check('8页帖: 补齐16页, 空白6', plan.totalPadded === 16 && plan.blankCount === 6);
  const t1 = plan.signatures[0].sheets;
  check('帖1纸1 正 8/1', t1[0].front.left === 8 && t1[0].front.right === 1);
  check('帖1纸1 反 2/7', t1[0].back.left === 2 && t1[0].back.right === 7);
  check('帖1纸2 正 6/3', t1[1].front.left === 6 && t1[1].front.right === 3);
  check('帖1纸2 反 4/5', t1[1].back.left === 4 && t1[1].back.right === 5);

  // 恰好整帖不补白
  plan = buildPlan(8, 2);
  check('整帖不补白', plan.blankCount === 0 && plan.signatureCount === 1);
  plan = buildPlan(4, 1);
  check('4页1帖不补白', plan.blankCount === 0);

  // ---- 生成 PDF 结构校验 ----
  const src = await makeSource(9);
  const p1 = buildPlan(9, 1);
  const out1 = await createImposedPdf(src, p1);
  check('9页4页帖 -> 3张纸6个拼版面', out1.getPageCount() === 6);
  for (let i = 0; i < out1.getPageCount(); i++) {
    const { width, height } = out1.getPage(i).getSize();
    check(`面${i + 1} 为A4横向(${width.toFixed(0)}x${height.toFixed(0)})`,
      Math.abs(width - 841.89) < 1 && Math.abs(height - 595.28) < 1);
  }

  const src2 = await makeSource(10);
  const p2 = buildPlan(10, 2);
  const out2 = await createImposedPdf(src2, p2);
  check('10页8页帖 -> 4张纸8个拼版面', out2.getPageCount() === 8);

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
  await require('fs').promises.writeFile('/workspace/test-out-rotated.pdf', await out3.save());
  console.log('样例 PDF 已写出，供人工查看');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
