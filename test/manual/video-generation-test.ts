#!/usr/bin/env tsx

/**
 * 测试视频生成完整流程
 * 包括 omni_reference 模式测试
 */

const API_BASE = 'http://localhost:5100';

async function testVideoGeneration() {
  console.log('=== 视频生成完整流程测试 ===\n');

  const testCases = [
    {
      name: '测试 1: omni_reference 模式 (参考视频)',
      data: {
        model: 'jimeng-video-seedance-2.0',
        prompt: '一只可爱的猫咪在玩耍',
        function_mode: 'omni_reference',
        video_url: 'https://lf-jianying-codecz3.byteimg.com/obj/eden-cn/uhbfnupenuhf/seedance_tutorial.mp4',
        ratio: '16:9',
        video_duration: 5,
      },
    },
    {
      name: '测试 2: 纯文本生成 (如果测试 1 失败)',
      data: {
        model: 'jimeng-video-seedance-2.0',
        prompt: '一只可爱的猫咪在玩耍',
        ratio: '16:9',
        video_duration: 5,
      },
    },
  ];

  for (const testCase of testCases) {
    console.log(`\n📝 ${testCase.name}`);
    console.log(`参数: ${JSON.stringify(testCase.data, null, 2)}\n`);

    try {
      const response = await fetch(`${API_BASE}/v1/videos/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer cff8c2ee2af8fe709655b1417aac33ab`,
        },
        body: JSON.stringify(testCase.data),
      });

      console.log(`响应状态: ${response.status} ${response.statusText}`);

      const responseText = await response.text();

      if (!response.ok) {
        console.error(`❌ 请求失败:`);
        console.error(responseText);
        console.log('\n尝试下一个测试用例...\n');
        continue;
      }

      const result = JSON.parse(responseText);
      console.log('✅ 请求成功!');
      console.log(`\n响应数据:\n${JSON.stringify(result, null, 2)}\n`);

      // 如果有 task_id,可以轮询检查生成状态
      if (result.data?.id || result.id) {
        const taskId = result.data?.id || result.id;
        console.log(`任务 ID: ${taskId}`);

        if (testCase.name.includes('omni_reference')) {
          console.log('\n✅ omni_reference 模式测试成功!');
          console.log('提示: 可以使用 task_id 查询生成状态和下载视频\n');
          break; // omni_reference 成功就退出
        }
      }

    } catch (error: any) {
      console.error(`❌ 测试失败: ${error.message}\n`);
    }
  }

  console.log('=== 测试完成 ===');
}

// 运行测试
testVideoGeneration().catch(console.error);
