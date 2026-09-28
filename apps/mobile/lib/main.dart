import 'main_customer.dart' as customer;
import 'main_staff.dart' as staff;

/// Default entry point: `--dart-define=FLAVOR=staff` runs the staff app, anything else the customer app.
/// Release builds use the dedicated `lib/main_staff.dart` / `lib/main_customer.dart` targets.
void main() {
  const flavor = String.fromEnvironment('FLAVOR', defaultValue: 'customer');
  if (flavor == 'staff') {
    staff.main();
  } else {
    customer.main();
  }
}
