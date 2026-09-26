'use strict';

// 临时测试脚本：验证章节起页解析、书序构造、拼版计划与生成 PDF 的结构。用完即删。
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const {
  app,
  parseChapterStarts,
  buildBookOrder,
  buildPlan,
  createImposedPdf,
} = require('../server.js');

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

// 书序槽位简写：1 -> P1，'B' -> 章节空白
function orderSummary(order) {
  return order.map((s) => (s.kind === 'page' ? s.source : 'B'));
}

function expectThrow(label, fn, pattern) {
  try {
    fn();
    check(label, false);
  } catch (err) {
    check(`${label}（${err.message}）`, pattern.test(err.message));
  }
}

async function run() {
  // ---- 章节起页解析 ----
  check('空输入 -> 空数组', parseChapterStarts('', 6).length === 0);
  check('空白输入 -> 空数组', parseChapterStarts('   ', 6).length === 0);
  check('undefined -> 空数组', parseChapterStarts(undefined, 6).length === 0);
  check(
    '正常解析并排序去空格',
    JSON.stringify(parseChapterStarts(' 3 , 2 ', 6)) === '[2,3]'
  );
  check(
    '兼容中文逗号',
    JSON.stringify(parseChapterStarts('2，3', 6)) === '[2,3]'
  );
  expectThrow('重复页码报错', () => parseChapterStarts('2,2', 6), /重复/);
  expectThrow('非整数报错(字母)', () => parseChapterStarts('a,2', 6), /不是整数/);
  expectThrow('非整数报错(小数)', () => parseChapterStarts('1.5', 6), /不是整数/);
  expectThrow('空段报错', () => parseChapterStarts('2,,3', 6), /不是整数/);
  expectThrow('越界报错(超上限)', () => parseChapterStarts('7', 6), /超出范围/);
  expectThrow('越界报错(0)', () => parseChapterStarts('0', 6), /超出范围/);
  expectThrow('越界报错(负数)', () => parseChapterStarts('-1', 6), /超出范围/);

  // ---- 书序构造 ----
  // 题目示例：6 页指定 2,3 -> 1、空白、2、空白、3、4、5、6
  const order6 = buildBookOrder(6, [2, 3]);
  check(
    '6页指定2,3 -> 1,B,2,B,3,4,5,6',
    JSON.stringify(orderSummary(order6)) === '[1,"B",2,"B",3,4,5,6]'
  );
  check('不指定 -> 无空白', buildBookOrder(6).every((s) => s.kind === 'page'));
  check(
    '第1页天然在右页，指定1不插空白',
    JSON.stringify(orderSummary(buildBookOrder(4, [1]))) === '[1,2,3,4]'
  );
  check(
    '指定页本在奇数位则不插空白',
    JSON.stringify(orderSummary(buildBookOrder(5, [3]))) === '[1,2,3,4,5]'
  );
  check(
    '单个偶数位起页',
    JSON.stringify(orderSummary(buildBookOrder(5, [2]))) === '[1,"B",2,3,4,5]'
  );
  check(
    '插空计入后续判断',
    JSON.stringify(orderSummary(buildBookOrder(4, [2, 3, 4]))) === '[1,"B",2,"B",3,"B",4]'
  );
  // 原页不遗漏、不重复
  const sources = order6.filter((s) => s.kind === 'page').map((s) => s.source);
  check(
    '书序中每个原页恰好出现一次',
    JSON.stringify(sources) === '[1,2,3,4,5,6]'
  );

  // ---- 计划校验：4页 / 帖（数字入参，向后兼容）----
  let plan = buildPlan(9, 1);
  check('4页帖: 共3帖', plan.signatureCount === 3);
  check('4页帖: 补齐后12页, 空白3', plan.totalPadded === 12 && plan.blankCount === 3);
  check('4页帖: 书序9页, 无章节空白', plan.bookCount === 9 && plan.chapterBlankCount === 0);
  // 第3帖（书序9,10,11,12 中后3个为末帖补白）: 正 补白/P9, 反 补白/补白
  const s3 = plan.signatures[2].sheets[0];
  check('末帖正面 补白/P9', s3.front.left === null && s3.front.right.source === 9);
  check('末帖反面 补白/补白', s3.back.left === null && s3.back.right === null);

  // ---- 计划校验：8页 / 帖 ----
  plan = buildPlan(10, 2);
  check('8页帖: 共2帖', plan.signatureCount === 2);
  check('8页帖: 补齐16页, 空白6', plan.totalPadded === 16 && plan.blankCount === 6);
  const t1 = plan.signatures[0].sheets;
  check('帖1纸1 正 8/1', t1[0].front.left.source === 8 && t1[0].front.right.source === 1);
  check('帖1纸1 反 2/7', t1[0].back.left.source === 2 && t1[0].back.right.source === 7);
  check('帖1纸2 正 6/3', t1[1].front.left.source === 6 && t1[1].front.right.source === 3);
  check('帖1纸2 反 4/5', t1[1].back.left.source === 4 && t1[1].back.right.source === 5);

  // 恰好整帖不补白
  plan = buildPlan(8, 2);
  check('整帖不补白', plan.blankCount === 0 && plan.signatureCount === 1);
  plan = buildPlan(4, 1);
  check('4页1帖不补白', plan.blankCount === 0);

  // ---- 计划校验：章节起页（6页指定2,3，书序8页，每帖4页）----
  plan = buildPlan(buildBookOrder(6, [2, 3]), 1);
  check('章节起页: 书序8页', plan.bookCount === 8 && plan.sourceCount === 6);
  check('章节起页: 章节空白2页', plan.chapterBlankCount === 2);
  check('章节起页: 共2帖且末帖不补白', plan.signatureCount === 2 && plan.blankCount === 0);
  const c1 = plan.signatures[0].sheets[0];
  check(
    '帖1正面 章节空白/P1',
    c1.front.left.kind === 'chapterBlank' && c1.front.right.source === 1
  );
  check(
    '帖1反面 章节空白/P2',
    c1.back.left.kind === 'chapterBlank' && c1.back.right.source === 2
  );
  const c2 = plan.signatures[1].sheets[0];
  check('帖2正面 P6/P3', c2.front.left.source === 6 && c2.front.right.source === 3);
  check('帖2反面 P4/P5', c2.back.left.source === 4 && c2.back.right.source === 5);

  // 章节空白 + 末帖补白并存：5页指定2 -> 书序 1,B,2,3,4,5 -> 每帖4页补到8
  plan = buildPlan(buildBookOrder(5, [2]), 1);
  check(
    '章节空白与末帖补白并存: 书序6, 补白2',
    plan.bookCount === 6 && plan.chapterBlankCount === 1 && plan.blankCount === 2
  );
  const lastSheet = plan.signatures[1].sheets[0];
  check(
    '末帖正面 补白/P4',
    lastSheet.front.left === null && lastSheet.front.right.source === 4
  );
  check(
    '末帖反面 P5/补白',
    lastSheet.back.left.source === 5 && lastSheet.back.right === null
  );

  // 计划内所有槽位：原页不遗漏不重复
  const allSlots = [];
  for (const sig of plan.signatures) {
    for (const sheet of sig.sheets) {
      for (const side of ['front', 'back']) {
        allSlots.push(sheet[side].left, sheet[side].right);
      }
    }
  }
  const pageSources = allSlots
    .filter((s) => s && s.kind === 'page')
    .map((s) => s.source)
    .sort((a, b) => a - b);
  check(
    '计划槽位覆盖原页1..5各一次',
    JSON.stringify(pageSources) === '[1,2,3,4,5]'
  );

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

  // 章节起页：6页指定2,3 -> 书序8页 -> 2帖4面
  const srcC = await makeSource(6);
  const outC = await createImposedPdf(srcC, buildPlan(buildBookOrder(6, [2, 3]), 1));
  check('6页指定2,3 -> 2张纸4个拼版面', outC.getPageCount() === 4);

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

  // ---- API 端到端 ----
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const api = `http://127.0.0.1:${port}/api/impose`;
  const pdfBytes = await (await makeSource(6)).save();

  const post = async (chapterStarts) => {
    const form = new FormData();
    form.append('pdf', new Blob([pdfBytes], { type: 'application/pdf' }), 'sample.pdf');
    form.append('sheetsPerSignature', '1');
    if (chapterStarts !== undefined) form.append('chapterStarts', chapterStarts);
    const resp = await fetch(api, { method: 'POST', body: form });
    return { status: resp.status, data: await resp.json() };
  };

  let r = await post('2,3');
  check('API: 指定2,3 返回200', r.status === 200);
  check(
    'API: 书序8页/章节空白2/末帖补白0',
    r.data.bookCount === 8 && r.data.chapterBlankCount === 2 && r.data.blankCount === 0
  );
  check(
    'API: 书序映射 1,B,2,B,3,4,5,6',
    JSON.stringify(orderSummary(r.data.bookOrder)) === '[1,"B",2,"B",3,4,5,6]'
  );
  check('API: 返回2帖', r.data.signatureCount === 2 && r.data.outputPages === 4);
  const apiPdf = await PDFDocument.load(Buffer.from(r.data.pdfBase64, 'base64'));
  check('API: 下载PDF共4面', apiPdf.getPageCount() === 4);

  r = await post('');
  check('API: 留空沿用原结果(书序6页, 补白2)', r.status === 200 && r.data.bookCount === 6 && r.data.blankCount === 2);

  r = await post('2,2');
  check('API: 重复页码 400', r.status === 400 && /重复/.test(r.data.error));
  r = await post('abc');
  check('API: 非整数 400', r.status === 400 && /不是整数/.test(r.data.error));
  r = await post('7');
  check('API: 越界 400', r.status === 400 && /超出范围/.test(r.data.error));

  server.close();

  await require('fs').promises.writeFile('/workspace/test-out-9p-4s.pdf', await out1.save());
  await require('fs').promises.writeFile('/workspace/test-out-10p-8s.pdf', await out2.save());
  await require('fs').promises.writeFile('/workspace/test-out-rotated.pdf', await out3.save());
  await require('fs').promises.writeFile('/workspace/test-out-6p-ch2,3.pdf', await outC.save());
  console.log('样例 PDF 已写出，供人工查看');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
