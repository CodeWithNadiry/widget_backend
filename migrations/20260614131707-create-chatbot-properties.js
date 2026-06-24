export async function up(queryInterface, Sequelize) {
  await queryInterface.createTable('chatbotProperties', {
    chatbotPropertiesId: {
      type: Sequelize.UUID,
      defaultValue: Sequelize.UUIDV4,
      primaryKey: true,
    },

    chatbotId: {
      type: Sequelize.UUID,
      allowNull: false,
      references: {
        model: 'chatbots',
        key: 'chatbotId',
      },
      onDelete: 'CASCADE',
    },

    propertyId: {
      type: Sequelize.UUID,
      allowNull: false,
      references: {
        model: 'properties',
        key: 'propertyId',
      },
      onDelete: 'CASCADE',
    },

    createdAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },

    updatedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
  });

  // Prevent duplicate chatbot ↔ property links
  await queryInterface.addIndex('chatbotProperties', ['chatbotId', 'propertyId'], {
    unique: true,
    name: 'chatbot_property_unique',
  });
}

export async function down(queryInterface) {
  await queryInterface.dropTable('chatbotProperties');
}