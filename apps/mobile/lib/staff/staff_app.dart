import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/config.dart';
import '../core/theme.dart';
import 'my_day_screen.dart';
import 'queue_screen.dart';
import 'sessions_screen.dart';
import 'staff_login_screen.dart';
import 'staff_profile_screen.dart';
import 'staff_session.dart';

class StaffApp extends StatelessWidget {
  const StaffApp({super.key, required this.config, required this.api});

  final AppConfig config;
  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        Provider.value(value: config),
        Provider.value(value: api),
        ChangeNotifierProvider(create: (_) => StaffSession(api)..restore()),
      ],
      child: MaterialApp(
        title: config.appName,
        debugShowCheckedModeBanner: false,
        theme: buildTheme(brandTeal),
        home: const _Gate(),
      ),
    );
  }
}

class _Gate extends StatelessWidget {
  const _Gate();

  @override
  Widget build(BuildContext context) {
    final session = context.watch<StaffSession>();
    switch (session.state) {
      case SessionState.loading:
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      case SessionState.signedOut:
        return const StaffLoginScreen();
      case SessionState.signedIn:
        return const StaffHome();
    }
  }
}

class StaffHome extends StatefulWidget {
  const StaffHome({super.key});

  @override
  State<StaffHome> createState() => _StaffHomeState();
}

class _StaffHomeState extends State<StaffHome> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<StaffSession>();
    final tabs = <(NavigationDestination, Widget)>[
      if (session.isTherapist) (const NavigationDestination(icon: Icon(Icons.today_outlined), selectedIcon: Icon(Icons.today), label: 'My day'), const MyDayScreen()),
      if (session.can('session.read')) (const NavigationDestination(icon: Icon(Icons.spa_outlined), selectedIcon: Icon(Icons.spa), label: 'Sessions'), const SessionsScreen()),
      if (session.can('queue.read')) (const NavigationDestination(icon: Icon(Icons.people_alt_outlined), selectedIcon: Icon(Icons.people_alt), label: 'Queue'), const QueueScreen()),
      (const NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Profile'), const StaffProfileScreen()),
    ];
    final index = _index.clamp(0, tabs.length - 1);
    return Scaffold(
      body: IndexedStack(index: index, children: tabs.map((t) => t.$2).toList()),
      bottomNavigationBar: NavigationBar(selectedIndex: index, onDestinationSelected: (i) => setState(() => _index = i), destinations: tabs.map((t) => t.$1).toList()),
    );
  }
}
