# Spec: Тест ask_owner flow

## Цель

Проверить что механизм `ask_owner` (задать вопрос владельцу через MCP) работает end-to-end в пайплайне аналитика.

## Диаграмма flow

```mermaid
sequenceDiagram
    participant Owner as Владелец
    participant NF as Neuroforge
    participant Analyst as Аналитик (Claude)
    participant MCP as MCP Server

    Owner->>NF: Создать задачу "Тест ask_owner"
    NF->>Analyst: run(prompt)
    Analyst->>MCP: ask_question("Какой цвет?")
    MCP->>NF: Приостановить run
    NF->>Owner: callback { type: "question" }
    Owner->>NF: reply("Синий")
    NF->>Analyst: Продолжить с ответом
    Analyst->>MCP: complete(output)
    MCP->>NF: Завершить run
```

## Диаграмма состояний задачи

```mermaid
stateDiagram-v2
    [*] --> pending: createTask
    pending --> in_progress: activateIfNoActive
    in_progress --> waiting_reply: ask_question
    waiting_reply --> in_progress: reply
    in_progress --> done: complete
```

## Изменения

**Нет изменений в коде.** Это тестовая задача для валидации существующего механизма.

## Результат теста

| Шаг | Статус |
|---|---|
| Аналитик запущен | ✅ |
| Вопрос задан через MCP | ✅ |
| Выполнение приостановлено | ✅ |
| Ответ получен: «Синий» | ✅ |
| Работа продолжена | ✅ |

## Acceptance Criteria

1. ✅ Аналитик вызывает `ask_question` с переданным вопросом
2. ✅ Владелец получает вопрос и отвечает
3. ✅ Аналитик получает ответ и продолжает работу
4. ✅ Ответ учтён в дальнейших действиях (цвет кнопки = синий)
