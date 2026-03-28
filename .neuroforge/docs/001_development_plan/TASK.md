# Task 001: План разработки Нейроцеха — разбивка на спринты

## Тип
research

## Приоритет
critical

## Описание
Исследовать архитектуру, определить зависимости между компонентами, разбить разработку на спринты с чёткими deliverables. Результат — дорожная карта реализации.

## Acceptance Criteria
- [ ] Собран research по текущему состоянию проекта
- [ ] Определены зависимости между компонентами
- [ ] Разработка разбита на спринты с deliverables
- [ ] Каждый спринт имеет чёткие задачи и acceptance criteria

## Контекст
- Архитектура: `docs/architecture/neuroforge.md`
- Референс: `/root/bot/mybot/` (mybot — донор кода)
- 34 принятых архитектурных решения (ADR)

## Затрагиваемые компоненты
- Domain: entities, ports, services
- Application: use cases
- Infrastructure: persistence, claude adapter, http, scheduler, callback

## Ограничения и риски
- Сервер: 2 CPU, 3.8 ГБ RAM, 79 ГБ диск
- Claude CLI — внешняя зависимость, нет SDK
- PostgreSQL — единственная БД (и данные, и очередь)
