import 'package:flutter/material.dart';

import 'core/api_client.dart';
import 'core/config.dart';
import 'core/token_store.dart';
import 'customer/customer_app.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final config = AppConfig.fromEnvironment(AppFlavor.customer);
  final api = ApiClient(baseUrl: config.apiBase, tokens: SecureTokenStore('customer'), refreshPath: '/portal/auth/refresh');
  runApp(CustomerApp(config: config, api: api));
}
