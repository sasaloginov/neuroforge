# NF-27: Ключевые решения

## ADR-1: Куда класть артефакты аналитика

### Контекст
Сейчас артефакты в `docs/analyst/<shortId>/` внутри каждого проекта. Задача предлагает перенести в `.neuroforge/docs/<shortId>/`.

### Варианты
1. **`.neuroforge/docs/<taskId>/`** — всё Нейроцех-специфичное в одной папке
2. **Оставить `docs/analyst/`** — не ломать существующее, только стандартизировать roles и config

### Решение: Вариант 1 — `.neuroforge/docs/<taskId>/`
- Единая конвенция `.neuroforge/` для всего, что связано с Нейроцехом
- Чистый корень проекта — разработчики не путают свою docs/ с Нейроцех-артефактами
- `.neuroforge/` можно добавить в `.gitignore` docs/ если проект не хочет коммитить спеки
- Миграцию существующих артефактов делать НЕ нужно — старые задачи уже закрыты

## ADR-2: Глобальные vs per-project роли для Neuroforge

### Контекст
neuroforge — одновременно и сервер, и проект. Его роли в `roles/` — глобальные (default для всех проектов). Если перенести в `.neuroforge/roles/`, они станут per-project override.

### Решение: Не переносить глобальные роли
`roles/` в корне neuroforge — это **глобальные дефолтные роли**, а не per-project override. Перенос `roles/` → `.neuroforge/roles/` семантически неверен: `.neuroforge/roles/` — это кастомизация для конкретного проекта.

Вместо этого:
- `roles/` остаётся как есть — глобальные роли (source of truth)
- `.neuroforge/` для neuroforge создаётся с `config.json` и `docs/` (как для любого проекта)
- `ROLES_DIR` default не меняется

Это **противоречит** пункту AC-2 задачи ("Роли neuroforge перенесены из `roles/` в `.neuroforge/roles/`"), но перенос создаёт проблемы:
- Ломает семантику: глобальные роли ≠ per-project override
- Требует изменения критичного файла `src/index.js`
- Тесты fileRoleLoader завязаны на `../../../roles`
- Если нужны кастомные роли для neuroforge-как-проекта — они могут быть в `.neuroforge/roles/` как override глобальных

## ADR-3: config.json — runtime или convention-only

### Контекст
`config.json` предлагается как метаданные проекта (name, stack, testCommand). Нужно ли его читать в runtime или только для агентов?

### Решение: Convention-only (для агентов)
- config.json НЕ читается кодом Нейроцеха
- Используется агентами (analyst, developer) для понимания стека проекта
- Онбордер создаёт config.json при onboarding
- Это минимизирует изменения в коде и снижает coupling

## ADR-4: Структура `.neuroforge/docs/<taskId>/`

### Решение
Сохраняем текущую структуру, только меняем корневой путь:
```
.neuroforge/docs/<taskId>/
├── research/
│   └── <slug>.md
├── design/
│   └── spec.md
└── context.md
```
