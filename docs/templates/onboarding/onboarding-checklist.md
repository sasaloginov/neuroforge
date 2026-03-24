# Onboarding Checklist

## Анализ проекта
- [ ] Прочитать README.md
- [ ] Определить стек (язык, фреймворк, БД, тесты)
- [ ] Понять структуру директорий
- [ ] Найти команды запуска (dev, test, build)

## CLAUDE.md
- [ ] Проверить: существует ли CLAUDE.md?
  - Если да: дополнить секцией "Task Manager (Нейроцех)"
  - Если нет: создать из шаблона, заполнив реальными данными
- [ ] Убедиться что описание проекта актуально
- [ ] Убедиться что структура директорий отражает реальность
- [ ] Убедиться что команды запуска рабочие

## .claude/settings.local.json
- [ ] Создать/обновить с permissions для стека проекта:
  - Всегда: git, ls, grep
  - Node.js: npm, npx, node
  - PHP: php, composer, ./vendor/bin/phpunit
  - Python: python3, pip, pytest
  - Go: go
  - Swift: swift, xcodebuild
  - Kotlin/Android: ./gradlew, adb
  - Dart/Flutter: flutter, dart
  - Docker: docker-compose

## PROJECT_MAP.md
- [ ] Если нет — создать карту основных модулей проекта
- [ ] Если есть — проверить актуальность

## Финализация
- [ ] git add && git commit -m "chore: neuroforge onboarding" && git push
