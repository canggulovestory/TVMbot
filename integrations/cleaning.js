// integrations/cleaning.js — Villa Cleaning Schedule Generator

async function generateWeeklySchedule(checkIns = [], checkOuts = [], villaName = '') {
  const schedule = [];
  const allDates = new Set([...checkIns, ...checkOuts]);

  for (const date of allDates) {
    const isCheckIn = checkIns.includes(date);
    const isCheckOut = checkOuts.includes(date);

    const task = {
      date,
      villa: villaName,
      type: isCheckOut && isCheckIn ? 'turnover' : isCheckOut ? 'checkout_clean' : 'checkin_prep',
      tasks: [],
      estimatedHours: 0
    };

    if (isCheckOut || task.type === 'turnover') {
      task.tasks.push(
        'Strip and wash all bed linens', 'Deep clean all bathrooms',
        'Vacuum and mop all floors', 'Clean kitchen (inside fridge, oven, counters)',
        'Wash dishes and utensils', 'Empty all rubbish bins',
        'Wipe down all surfaces', 'Clean windows and mirrors',
        'Check and restock toiletries', 'Check for damage/missing items',
        'Take photos of villa condition'
      );
      task.estimatedHours = 4;
    }

    if (isCheckIn || task.type === 'turnover') {
      task.tasks.push(
        'Make up fresh beds with clean linens', 'Place welcome basket/amenities',
        'Check all appliances working', 'Set AC to welcome temperature (25°C)',
        'Ensure pool/garden is tidy', 'Leave house manual and WiFi info visible',
        'Final walkthrough and quality check'
      );
      task.estimatedHours += 1.5;
    }

    schedule.push(task);
  }

  return schedule.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function formatScheduleText(schedule) {
  if (!schedule || schedule.length === 0) return 'No cleaning tasks scheduled.';

  let text = `🏠 CLEANING SCHEDULE\n${'='.repeat(40)}\n\n`;

  for (const task of schedule) {
    const typeLabel = task.type === 'turnover' ? '🔄 TURNOVER' :
                      task.type === 'checkout_clean' ? '🧹 CHECKOUT CLEAN' : '✨ CHECK-IN PREP';
    text += `${typeLabel} — ${task.date}\n`;
    text += `Villa: ${task.villa || 'N/A'} | Est. time: ${task.estimatedHours}h\n`;
    text += `Tasks:\n`;
    for (const t of task.tasks) text += `  • ${t}\n`;
    text += '\n';
  }

  return text;
}

module.exports = { generateWeeklySchedule, formatScheduleText };
