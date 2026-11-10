# Export integration test diagnostics

Source commit: 92853f047b115b16f8138a79229b3273e4f72b87

Test process exit code: 1

Reported test cases: 336
Failed test cases: 2

## экспорт рассказов: названия без номеров и содержание; роман: нумерация как раньше

Suite: test

```text
The input did not match the regular expression /## 2\. Лисья нора/. Input:'# Сборник\n\n## Глава 1\n\nПервый текст.\n\n---\n\n## Лисья нора\n\nВторой текст.\n'

[Error [ERR_TEST_FAILURE]: The input did not match the regular expression /## 2\. Лисья нора/. Input:

'# Сборник\n\n## Глава 1\n\nПервый текст.\n\n---\n\n## Лисья нора\n\nВторой текст.\n'
] {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /## 2\. Лисья нора/. Input:
  
  '# Сборник\n\n## Глава 1\n\nПервый текст.\n\n---\n\n## Лисья нора\n\nВторой текст.\n'
  
      at TestContext.<anonymous> (/home/runner/work/kabinet/kabinet/test/mode.test.js:61:10)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1047:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:744:18)
      at Test.postRun (node:internal/test_runner/test:1173:19)
      at Test.run (node:internal/test_runner/test:1101:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: '# Сборник\n\n## Глава 1\n\nПервый текст.\n\n---\n\n## Лисья нора\n\nВторой текст.\n',
    expected: /## 2\. Лисья нора/,
    operator: 'match',
    diff: 'simple'
  }
}
		
```

## экспорт: markdown, текст, html

Suite: test

```text
The input did not match the regular expression /## 1\. Начало/. Input:'# Книга\n' +  '\n' +  '## Начало\n' +  '\n' +  'Один **жирный** и *косой* <тег>.\n' +  '\n' +  '> цитата\n' +  '\n' +  '- раз\n' +  '- два\n' +  '\n' +  '---\n' +  '\n' +  'конец\n'

[Error [ERR_TEST_FAILURE]: The input did not match the regular expression /## 1\. Начало/. Input:

'# Книга\n' +
  '\n' +
  '## Начало\n' +
  '\n' +
  'Один **жирный** и *косой* <тег>.\n' +
  '\n' +
  '> цитата\n' +
  '\n' +
  '- раз\n' +
  '- два\n' +
  '\n' +
  '---\n' +
  '\n' +
  'конец\n'
] {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /## 1\. Начало/. Input:
  
  '# Книга\n' +
    '\n' +
    '## Начало\n' +
    '\n' +
    'Один **жирный** и *косой* <тег>.\n' +
    '\n' +
    '> цитата\n' +
    '\n' +
    '- раз\n' +
    '- два\n' +
    '\n' +
    '---\n' +
    '\n' +
    'конец\n'
  
      at TestContext.<anonymous> (/home/runner/work/kabinet/kabinet/test/project.test.js:563:10)
      at Test.runInAsyncScope (node:async_hooks:214:14)
      at Test.run (node:internal/test_runner/test:1047:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:744:18)
      at Test.postRun (node:internal/test_runner/test:1173:19)
      at Test.run (node:internal/test_runner/test:1101:12)
      at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: '# Книга\n\n## Начало\n\nОдин **жирный** и *косой* <тег>.\n\n> цитата\n\n- раз\n- два\n\n---\n\nконец\n',
    expected: /## 1\. Начало/,
    operator: 'match',
    diff: 'simple'
  }
}
		
```

