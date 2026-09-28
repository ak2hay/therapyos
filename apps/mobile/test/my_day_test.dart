import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:therapyos_mobile/core/api_client.dart';
import 'package:therapyos_mobile/core/format.dart';
import 'package:therapyos_mobile/core/token_store.dart';
import 'package:therapyos_mobile/staff/my_day_screen.dart';
import 'package:therapyos_mobile/staff/staff_session.dart';

import 'support/fake_backend.dart';

Map<String, dynamic> _session(String status, {int elapsed = 0}) => {
      'id': 's1',
      'status': status,
      'notes': null,
      'room': null,
      'elapsedSeconds': elapsed,
      'customer': {'id': 'c1', 'name': 'Aarav Kapoor', 'phone': '+91••••••0036', 'customerCode': 'C-0036'},
      'service': {'id': 'sv1', 'name': 'Deep Tissue Massage', 'durationMinutes': 60},
      'therapist': {'id': 't1', 'name': 'Anita Rao'},
      'previousSessions': <Object>[],
    };

Map<String, dynamic> _day({Map<String, dynamic>? active}) => {
      'date': isoDate(DateTime.now()),
      'activeSession': active,
      'appointments': [
        {
          'id': 'a1',
          'status': 'CONFIRMED',
          'localStart': '11:00',
          'localEnd': '12:00',
          'customer': {'id': 'c1', 'name': 'Aarav Kapoor'},
          'service': {'id': 'sv1', 'name': 'Deep Tissue Massage'},
          'branch': {'id': 'b1', 'name': 'Serenity Indiranagar'},
        },
      ],
      'assignedQueue': <Object>[],
      'completed': <Object>[],
      'stats': {'appointments': 1, 'completedToday': 0, 'monthSessions': 14, 'monthCommission': 12500},
    };

void main() {
  late FakeBackend backend;
  late StaffSession staff;

  Future<void> pumpMyDay(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    final tokens = MemoryTokenStore();
    await tokens.write(const Tokens(accessToken: 'staff-access', refreshToken: 'staff-refresh'));
    final api = backend.api(tokens: tokens);
    backend.routes['GET /auth/me'] = (_) => {
          'name': 'Anita Rao',
          'therapistId': 't1',
          'currency': 'INR',
          'permissions': ['session.read.own', 'session.manage', 'session.notes', 'queue.read'],
          'branches': [
            {'id': 'b1', 'name': 'Serenity Indiranagar'},
          ],
        };
    staff = StaffSession(api);
    await staff.restore();
    await tester.pumpWidget(MultiProvider(
      providers: [Provider<ApiClient>.value(value: api), ChangeNotifierProvider.value(value: staff)],
      child: const MaterialApp(home: MyDayScreen()),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  setUp(() => backend = FakeBackend());

  testWidgets('shows the day summary and starts an appointment into a live session', (tester) async {
    backend.routes['GET /sessions/my-day'] = (_) => _day();
    backend.routes['POST /appointments/a1/start'] = (_) => _session('IN_PROGRESS');
    backend.routes['GET /sessions/s1'] = (_) => _session('IN_PROGRESS', elapsed: 90);
    await pumpMyDay(tester);

    expect(staff.state, SessionState.signedIn);
    expect(find.text('Hello, Anita'), findsOneWidget);
    expect(find.text('Today'), findsOneWidget);
    expect(find.text('₹12,500'), findsOneWidget);
    expect(find.text('11:00 AM – 12:00 PM · Deep Tissue Massage'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Start'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(backend.calls, contains('POST /appointments/a1/start'));
    expect(find.text('Session'), findsOneWidget);
    expect(find.text('01:30'), findsOneWidget);
    expect(find.text('Pause'), findsOneWidget);
    expect(find.text('Complete'), findsOneWidget);

    await tester.pump(const Duration(seconds: 2));
    expect(find.text('01:32'), findsOneWidget);
  });

  testWidgets('with a session running, shows it on top and hides other Start buttons', (tester) async {
    backend.routes['GET /sessions/my-day'] = (_) => _day(active: _session('PAUSED', elapsed: 600));
    await pumpMyDay(tester);

    expect(find.text('In progress'), findsOneWidget);
    expect(find.text('Deep Tissue Massage · Paused'), findsOneWidget);
    expect(find.text('10:00'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Start'), findsNothing);

    await tester.pump(const Duration(seconds: 3));
    expect(find.text('10:00'), findsOneWidget, reason: 'a paused timer does not advance');
  });
}
