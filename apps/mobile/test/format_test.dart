import 'package:flutter_test/flutter_test.dart';
import 'package:therapyos_mobile/core/format.dart';

void main() {
  test('money uses Indian digit grouping and hides zero paise', () {
    expect(money(1500), '₹1,500');
    expect(money(150000), '₹1,50,000');
    expect(money(99.5), '₹99.50');
    expect(money(null), '₹0');
    expect(money(20, currency: 'USD'), 'USD 20');
  });

  test('timeLabel converts 24h clock times', () {
    expect(timeLabel('09:00'), '9:00 AM');
    expect(timeLabel('14:05'), '2:05 PM');
    expect(timeLabel('00:30'), '12:30 AM');
    expect(timeLabel('12:00'), '12:00 PM');
  });

  test('dayLabel names nearby days', () {
    final now = DateTime.now();
    expect(dayLabel(isoDate(now)), 'Today');
    expect(dayLabel(isoDate(now.add(const Duration(days: 1)))), 'Tomorrow');
    expect(dayLabel('not-a-date'), 'not-a-date');
  });

  test('duration formats a session timer', () {
    expect(duration(65), '01:05');
    expect(duration(3725), '1:02:05');
    expect(duration(-4), '00:00');
  });

  test('titleCase and initials', () {
    expect(titleCase('IN_PROGRESS'), 'In Progress');
    expect(initials('Aarav Kapoor'), 'AK');
    expect(initials('  meera '), 'M');
    expect(initials(''), '?');
  });
}
