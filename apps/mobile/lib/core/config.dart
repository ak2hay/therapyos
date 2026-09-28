import 'package:flutter/foundation.dart';

enum AppFlavor { staff, customer }

/// Build-time configuration, passed with `--dart-define`:
///   API_URL      base URL of the TherapyOS API (default: local dev server)
///   TENANT_SLUG  business the customer app belongs to (white-label builds set this)
///   APP_NAME     display name
class AppConfig {
  const AppConfig({required this.flavor, required this.apiUrl, required this.tenantSlug, required this.appName});

  final AppFlavor flavor;
  final String apiUrl;
  final String tenantSlug;
  final String appName;

  String get apiBase => '$apiUrl/api/v1';

  factory AppConfig.fromEnvironment(AppFlavor flavor) {
    const api = String.fromEnvironment('API_URL');
    const slug = String.fromEnvironment('TENANT_SLUG', defaultValue: 'serenity-wellness');
    const name = String.fromEnvironment('APP_NAME');
    return AppConfig(
      flavor: flavor,
      apiUrl: api.isNotEmpty ? api : _defaultApiUrl(),
      tenantSlug: slug,
      appName: name.isNotEmpty ? name : (flavor == AppFlavor.staff ? 'TherapyOS Staff' : 'TherapyOS'),
    );
  }

  /// The Android emulator reaches the host machine through 10.0.2.2.
  static String _defaultApiUrl() {
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) return 'http://10.0.2.2:4000';
    return 'http://localhost:4000';
  }
}
