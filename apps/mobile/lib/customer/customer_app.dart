import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/api_client.dart';
import '../core/config.dart';
import '../core/theme.dart';
import 'book_screen.dart';
import 'customer_login_screen.dart';
import 'customer_session.dart';
import 'home_screen.dart';
import 'payment_service.dart';
import 'profile_screen.dart';
import 'visits_screen.dart';
import 'wallet_screen.dart';

class CustomerApp extends StatelessWidget {
  const CustomerApp({super.key, required this.config, required this.api});

  final AppConfig config;
  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        Provider.value(value: config),
        Provider.value(value: api),
        Provider(create: (_) => PaymentService(api)),
        ChangeNotifierProvider(create: (_) => CustomerSession(api, config)..restore()),
      ],
      child: Consumer<CustomerSession>(
        builder: (context, session, _) => MaterialApp(
          title: session.state == CustomerState.signedIn ? session.businessName : config.appName,
          debugShowCheckedModeBanner: false,
          theme: buildTheme(session.brandColor),
          home: switch (session.state) {
            CustomerState.loading => const Scaffold(body: Center(child: CircularProgressIndicator())),
            CustomerState.signedOut => const CustomerLoginScreen(),
            CustomerState.signedIn => const CustomerHome(),
          },
        ),
      ),
    );
  }
}

/// Tabs of the signed-in customer app. Other screens switch tabs through [CustomerHome.of].
class CustomerHome extends StatefulWidget {
  const CustomerHome({super.key});

  static CustomerHomeState? of(BuildContext context) => context.findAncestorStateOfType<CustomerHomeState>();

  @override
  State<CustomerHome> createState() => CustomerHomeState();
}

class CustomerHomeState extends State<CustomerHome> {
  static const home = 0, book = 1, visits = 2, wallet = 3, profile = 4;
  int _index = home;
  int _generation = 0;

  void go(int tab) => setState(() {
        _index = tab;
        _generation++;
      });

  @override
  Widget build(BuildContext context) {
    // Screens rebuild with fresh data whenever the customer switches tab after an action elsewhere.
    final screens = [const HomeScreen(), const BookScreen(), const VisitsScreen(), const WalletScreen(), const ProfileScreen()];
    return Scaffold(
      body: KeyedSubtree(key: ValueKey('$_index-$_generation'), child: screens[_index]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: go,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.add_circle_outline), selectedIcon: Icon(Icons.add_circle), label: 'Book'),
          NavigationDestination(icon: Icon(Icons.event_note_outlined), selectedIcon: Icon(Icons.event_note), label: 'Visits'),
          NavigationDestination(icon: Icon(Icons.account_balance_wallet_outlined), selectedIcon: Icon(Icons.account_balance_wallet), label: 'Wallet'),
          NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }
}
