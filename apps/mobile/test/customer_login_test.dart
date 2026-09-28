import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:therapyos_mobile/core/config.dart';
import 'package:therapyos_mobile/core/token_store.dart';
import 'package:therapyos_mobile/customer/customer_login_screen.dart';
import 'package:therapyos_mobile/customer/customer_session.dart';

import 'support/fake_backend.dart';

void main() {
  const config = AppConfig(flavor: AppFlavor.customer, apiUrl: 'http://api.test', tenantSlug: 'serenity-wellness', appName: 'Serenity');

  Future<(FakeBackend, CustomerSession, MemoryTokenStore)> pumpLogin(WidgetTester tester) async {
    final backend = FakeBackend();
    final tokens = MemoryTokenStore();
    final session = CustomerSession(backend.api(tokens: tokens, refreshPath: '/portal/auth/refresh'), config);
    await tester.pumpWidget(MultiProvider(
      providers: [Provider.value(value: config), ChangeNotifierProvider.value(value: session)],
      child: const MaterialApp(home: CustomerLoginScreen()),
    ));
    return (backend, session, tokens);
  }

  testWidgets('a new number verifies the OTP, completes a profile and is signed in', (tester) async {
    final (backend, session, tokens) = await pumpLogin(tester);
    backend.routes['POST /portal/auth/send-otp'] = (_) => {'sent': true, 'devCode': '482913'};
    backend.routes['POST /portal/auth/verify-otp'] = (_) => {'needsProfile': true, 'signupToken': 'signup-token-0123456789abcdef'};
    backend.routes['POST /portal/auth/register'] = (_) => {
          'tokens': {'accessToken': 'cust-access', 'refreshToken': 'cust-refresh'},
          'customer': {'id': 'c1', 'name': 'Riya Sen'},
        };
    backend.routes['GET /portal/me'] = (_) => {
          'id': 'c1',
          'name': 'Riya Sen',
          'business': {'name': 'Serenity Wellness', 'currency': 'INR', 'primaryColor': '#7c3aed'},
        };

    await tester.tap(find.text('Send code'));
    await tester.pumpAndSettle();
    expect(find.text('Enter your 10 digit mobile number'), findsOneWidget);
    expect(backend.calls, isEmpty);

    await tester.enterText(find.widgetWithText(TextField, 'Mobile number'), '98450 77777');
    await tester.tap(find.text('Send code'));
    await tester.pumpAndSettle();
    expect(backend.bodyOf('POST /portal/auth/send-otp'), {'tenantSlug': 'serenity-wellness', 'phone': '98450 77777'});
    expect(find.text('Test mode code: 482913'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'Verification code'), '482913');
    await tester.tap(find.text('Verify'));
    await tester.pumpAndSettle();
    expect(find.text('Welcome! Just a couple of details to finish'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'Your name'), 'Riya Sen');
    await tester.tap(find.text('Create account'));
    await tester.pumpAndSettle();

    expect(backend.bodyOf('POST /portal/auth/register'), {'signupToken': 'signup-token-0123456789abcdef', 'name': 'Riya Sen'});
    expect(session.state, CustomerState.signedIn);
    expect(session.businessName, 'Serenity Wellness');
    expect(session.brandColor, const Color(0xFF7C3AED));
    expect((await tokens.read())!.accessToken, 'cust-access');
  });

  testWidgets('a wrong code shows the API error and stays on the code step', (tester) async {
    final (backend, session, _) = await pumpLogin(tester);
    backend.routes['POST /portal/auth/send-otp'] = (_) => {'sent': true};
    backend.routes['POST /portal/auth/verify-otp'] = (_) => FakeBackend.error(400, 'OTP_INVALID', 'That code is not right. 4 attempts left.');

    await tester.enterText(find.widgetWithText(TextField, 'Mobile number'), '9845010036');
    await tester.tap(find.text('Send code'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Test mode code'), findsNothing);

    await tester.enterText(find.widgetWithText(TextField, 'Verification code'), '111111');
    await tester.tap(find.text('Verify'));
    await tester.pumpAndSettle();

    expect(find.text('That code is not right. 4 attempts left.'), findsOneWidget);
    expect(find.text('Verify'), findsOneWidget);
    expect(session.state, isNot(CustomerState.signedIn));
  });
}
